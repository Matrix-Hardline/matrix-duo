// bt-probe: first sign-of-life test of the Bluetooth chip (WCN399x) on the Surface Duo. Own code.
// Sequence (research 31.10.2026, mainline hci_qca.c/btqca.c, CAF bluetooth-power.c):
//   ADSP must be ONLINE (Droidian port: Bluetooth against a dead ADSP blocks the kernel) ->
//   /dev/btpower ioctl 0xbfad(1) -> ttyHS0 raw, clock vote TIOCPMGET -> pulse C0 @2400 -> pulse FC @115200, 100 ms ->
//   RTS/CTS on -> version query 01 00 FC 01 19 -> print the answer -> btpower off. Writes nothing persistently.
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <poll.h>
#include <time.h>
#include <dirent.h>
#include <termios.h>
#include <sys/ioctl.h>

#define BT_CMD_PWR_CTRL 0xbfad
#define TIOCPMGET 0x544D
#define TIOCPMPUT 0x544E

static long long ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1000LL + t.tv_nsec / 1000000;
}

static int adsp_online(void) {
    DIR *d = opendir("/sys/bus/msm_subsys/devices");
    struct dirent *e;
    int ok = 0;
    if (!d) return 0;
    while ((e = readdir(d))) {
        char p[256], name[32] = {0}, state[32] = {0};
        FILE *f;
        if (e->d_name[0] == '.') continue;
        snprintf(p, sizeof p, "/sys/bus/msm_subsys/devices/%s/name", e->d_name);
        if (!(f = fopen(p, "r"))) continue;
        if (!fgets(name, sizeof name, f)) name[0] = 0;
        fclose(f);
        if (strncmp(name, "adsp", 4)) continue;
        snprintf(p, sizeof p, "/sys/bus/msm_subsys/devices/%s/state", e->d_name);
        if ((f = fopen(p, "r"))) {
            if (fgets(state, sizeof state, f) && !strncmp(state, "ONLINE", 6)) ok = 1;
            fclose(f);
        }
    }
    closedir(d);
    return ok;
}

static void port(int fd, speed_t sp, int flow) {
    struct termios t;
    tcgetattr(fd, &t);
    cfmakeraw(&t);
    t.c_cflag |= CLOCAL | CREAD;
    if (flow) t.c_cflag |= CRTSCTS; else t.c_cflag &= ~CRTSCTS;
    cfsetispeed(&t, sp);
    cfsetospeed(&t, sp);
    tcsetattr(fd, TCSANOW, &t);
}

static void dump(const char *what, const unsigned char *b, int n) {
    printf("%s (%d):", what, n);
    for (int i = 0; i < n; i++) printf(" %02x", b[i]);
    printf("\n");
}

static int readfor(int fd, unsigned char *b, int max, int wait_ms) {
    int n = 0;
    long long end = ms() + wait_ms;
    while (n < max) {
        long long left = end - ms();
        if (left <= 0) break;
        struct pollfd p = {.fd = fd, .events = POLLIN};
        if (poll(&p, 1, (int)left) <= 0) break;
        int r = read(fd, b + n, max - n);
        if (r <= 0) break;
        n += r;
        end = ms() + 150;   // after data, keep reading briefly
    }
    return n;
}

int main(void) {
    if (!adsp_online()) {
        fprintf(stderr, "bt-probe: ADSP nicht ONLINE -> Abbruch (Bluetooth gegen totes ADSP blockiert den Kernel)\n");
        return 2;
    }
    int pw = open("/dev/btpower", O_RDWR | O_CLOEXEC);
    if (pw < 0) { perror("/dev/btpower"); return 1; }
    if (ioctl(pw, BT_CMD_PWR_CTRL, 1) < 0) { perror("btpower an"); close(pw); return 1; }
    printf("btpower: an\n");
    usleep(100000);

    int fd = open("/dev/ttyHS0", O_RDWR | O_NOCTTY | O_CLOEXEC);
    int rc = 1;
    if (fd < 0) { perror("/dev/ttyHS0"); goto aus; }
    if (ioctl(fd, TIOCPMGET) < 0) printf("TIOCPMGET: %s (weiter)\n", strerror(errno));

    unsigned char b[512];
    // off pulse at 2400 baud, without flow control
    port(fd, B2400, 0);
    unsigned char off = 0xC0, on = 0xFC;
    write(fd, &off, 1); tcdrain(fd); usleep(10000);
    // on pulse at 115200
    port(fd, B115200, 0);
    write(fd, &on, 1); tcdrain(fd); usleep(100000);
    int n = readfor(fd, b, sizeof b, 50);
    if (n) dump("nach Puls", b, n);
    tcflush(fd, TCIOFLUSH);
    port(fd, B115200, 1);

    // Versionsabfrage (EDL 0xFC00, Unterbefehl 0x19)
    unsigned char ver[] = {0x01, 0x00, 0xFC, 0x01, 0x19};
    write(fd, ver, sizeof ver); tcdrain(fd);
    n = readfor(fd, b, sizeof b, 1000);
    dump("Antwort Version", b, n);
    for (int i = 0; i + 5 < n; i++) {
        // 04 FF len 00 02 product(4) patch(2) rom(2) soc(4)
        if (b[i] == 0x04 && b[i + 1] == 0xFF && i + 17 < n + 1 && b[i + 3] == 0x00 && b[i + 4] == 0x02 && i + 18 <= n) {
            unsigned prod = b[i+5] | b[i+6] << 8 | b[i+7] << 16 | (unsigned)b[i+8] << 24;
            unsigned patch = b[i+9] | b[i+10] << 8, rom = b[i+11] | b[i+12] << 8;
            unsigned soc = b[i+13] | b[i+14] << 8 | b[i+15] << 16 | (unsigned)b[i+16] << 24;
            printf("CHIP: product 0x%08x patch 0x%04x rom 0x%04x soc 0x%08x\n", prod, patch, rom, soc);
            rc = 0;
        }
    }
    if (n == 0) {
        // Gegenprobe: Standard-HCI-Reset
        unsigned char rst[] = {0x01, 0x03, 0x0C, 0x00};
        write(fd, rst, sizeof rst); tcdrain(fd);
        n = readfor(fd, b, sizeof b, 1000);
        dump("Antwort HCI_Reset", b, n);
    }
    ioctl(fd, TIOCPMPUT);
    close(fd);
aus:
    ioctl(pw, BT_CMD_PWR_CTRL, 0);
    close(pw);
    printf("btpower: aus\n");
    return rc;
}
