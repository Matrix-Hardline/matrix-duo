// duo-bt: Bluetooth for the Surface Duo (WCN3998 on /dev/ttyHS0) without a kernel driver. Own code.
// Brings the chip up like mainline hci_qca.c/btqca.c (research 31.10.2026, BLUETOOTH-RECHERCHE.md) and then passes
// H4 through between the UART and /dev/vhci, so that BlueZ sees a normal adapter.
//   Lock: ADSP must be ONLINE (Droidian Duo port: Bluetooth against a dead ADSP blocks the kernel).
//   btpower ioctl 0xbfad -> pulse C0@2400 / FC@115200 -> version (01 00 FC 01 19) -> 3 Mbaud (01 48 FC 01 0E) ->
//   rampatch qca/crbtfw21.tlv + NVM qca/crnv21.bin in chunks <= 243 bytes (01 00 FC n+2 1E n ...) -> HCI_Reset ->
//   /dev/vhci (FF 00) -> pass-through. The NVM is only adjusted in memory: in-band sleep (tag 17 bit 0x80) and
//   deep sleep (tag 27 bit 0x01) off, baud rate 3 Mbaud (tag 17 byte 2 = 0x0E), BD address (tag 2).
// Nothing is written persistently. End (SIGTERM): vhci closed, chip off.
#define _GNU_SOURCE
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <poll.h>
#include <time.h>
#include <signal.h>
#include <dirent.h>
#include <termios.h>
#include <sys/ioctl.h>

#define BT_CMD_PWR_CTRL 0xbfad
#define TIOCPMGET 0x544D
#define TIOCPMPUT 0x544E
#define SEG 243
#define BAUD_3M_IDX 0x0E
#define FW_DIR "/lib/firmware/qca/"

static int tty = -1, pw = -1, vh = -1;
static volatile sig_atomic_t stop;
static unsigned char bdaddr[6] = {0x50, 0x55, 0x44, 0x53, 0x4D, 0x02};   // 02:4D:53:44:55:50, bdaddr_t-Reihenfolge

static void on_sig(int s) { (void)s; stop = 1; }

static long long now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1000LL + t.tv_nsec / 1000000;
}

static void logf_(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void logf_(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fprintf(stderr, "duo-bt: ");
    vfprintf(stderr, fmt, ap);
    fprintf(stderr, "\n");
    va_end(ap);
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

static void port(speed_t sp, int flow) {
    struct termios t;
    tcgetattr(tty, &t);
    cfmakeraw(&t);
    t.c_cflag |= CLOCAL | CREAD;
    if (flow) t.c_cflag |= CRTSCTS; else t.c_cflag &= ~CRTSCTS;
    cfsetispeed(&t, sp);
    cfsetospeed(&t, sp);
    tcsetattr(tty, TCSANOW, &t);
}

static int wr(int fd, const void *buf, size_t n) {
    const unsigned char *p = buf;
    while (n) {
        ssize_t r = write(fd, p, n);
        if (r < 0) {
            if (errno == EINTR) continue;
            if (errno == EAGAIN) { struct pollfd q = {.fd = fd, .events = POLLOUT}; poll(&q, 1, 100); continue; }
            return -1;
        }
        p += r; n -= r;
    }
    return 0;
}

// ---- H4 reader for the UART (events during initialisation, frames during pass-through) ----
static unsigned char rx[4096];
static int rxn;

static int rx_fill(int wait_ms) {
    struct pollfd p = {.fd = tty, .events = POLLIN};
    if (poll(&p, 1, wait_ms) <= 0) return 0;
    int r = read(tty, rx + rxn, sizeof rx - rxn);
    if (r > 0) rxn += r;
    return r > 0 ? r : 0;
}

// Laenge eines vollstaendigen H4-Rahmens am Pufferanfang, 0 = unvollstaendig, -1 = Einzelbyte verwerfen
static int frame_len(const unsigned char *b, int n) {
    if (n < 1) return 0;
    switch (b[0]) {
    case 0x04: return n < 3 ? 0 : (3 + b[2] <= n ? 3 + b[2] : 0);
    case 0x02: { if (n < 5) return 0; int l = 5 + (b[3] | b[4] << 8); return l <= n ? l : 0; }
    case 0x03: return n < 4 ? 0 : (4 + b[3] <= n ? 4 + b[3] : 0);
    case 0x05: { if (n < 5) return 0; int l = 5 + ((b[3] | b[4] << 8) & 0x3fff); return l <= n ? l : 0; }
    default: return -1;   // IBS-Bytes (FD/FC/FE), Rauschen
    }
}

static void rx_drop(int k) { memmove(rx, rx + k, rxn - k); rxn -= k; }

// next HCI event (04 ...) within wait_ms into ev (without the type byte); 0 = timeout
static int next_event(unsigned char *ev, int max, int wait_ms) {
    long long end = now_ms() + wait_ms;
    for (;;) {
        int l;
        while (rxn > 0 && (l = frame_len(rx, rxn)) != 0) {
            if (l < 0) {
                if (rx[0] == 0xFD) { unsigned char a = 0xFC; wr(tty, &a, 1); }   // Wach-Anfrage beantworten
                rx_drop(1);
                continue;
            }
            int is_ev = rx[0] == 0x04;
            int c = l - 1 < max ? l - 1 : max;
            if (is_ev) memcpy(ev, rx + 1, c);
            rx_drop(l);
            if (is_ev) return c;
        }
        long long left = end - now_ms();
        if (left <= 0) return 0;
        rx_fill((int)left);
    }
}

// wait for a vendor event (FF) with the given subtype, skip other events
static int wait_vse(unsigned char rtype, unsigned char *out, int max, int wait_ms) {
    unsigned char ev[260];
    long long end = now_ms() + wait_ms;
    while (now_ms() < end) {
        int n = next_event(ev, sizeof ev, (int)(end - now_ms()));
        if (n <= 0) return -1;
        if (ev[0] == 0xFF && n >= 4 && ev[3] == rtype) {
            int c = n < max ? n : max;
            if (out) memcpy(out, ev, c);
            return c;
        }
    }
    return -1;
}

static int wait_cc(uint16_t op, int wait_ms) {
    unsigned char ev[260];
    long long end = now_ms() + wait_ms;
    while (now_ms() < end) {
        int n = next_event(ev, sizeof ev, (int)(end - now_ms()));
        if (n <= 0) return -1;
        if (ev[0] == 0x0E && n >= 6 && (ev[3] | ev[4] << 8) == op) return ev[5];
    }
    return -1;
}

static unsigned char *load(const char *path, size_t *len) {
    FILE *f = fopen(path, "rb");
    if (!f) { logf_("%s: %s", path, strerror(errno)); return NULL; }
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    unsigned char *b = malloc(n);
    if (!b || fread(b, 1, n, f) != (size_t)n) { fclose(f); free(b); return NULL; }
    fclose(f);
    *len = n;
    return b;
}

// adjust the NVM in memory (structure as in btqca.c qca_tlv_check_data)
static void patch_nvm(unsigned char *d, size_t len) {
    if (len < 8) return;
    uint32_t tl = d[0] | d[1] << 8 | d[2] << 16 | (uint32_t)d[3] << 24;
    size_t off = 4;
    if ((tl & 0xff) == 4) { tl = d[4] | d[5] << 8 | d[6] << 16 | (uint32_t)d[7] << 24; off = 8; }
    if ((tl & 0xff) != 2) { logf_("NVM: unerwarteter Typ %u", tl & 0xff); return; }
    size_t length = tl >> 8, i = 0;
    while (i + 12 <= length && off + i + 12 <= len) {
        unsigned char *t = d + off + i;
        unsigned tag = t[0] | t[1] << 8, tlen = t[2] | t[3] << 8;
        unsigned char *v = t + 12;
        if (off + i + 12 + tlen > len) break;
        if (tag == 2 && tlen == 6) memcpy(v, bdaddr, 6);
        if (tag == 17 && tlen >= 3) { v[0] &= ~0x80; v[2] = BAUD_3M_IDX; }
        if (tag == 27 && tlen >= 1) v[0] &= ~0x01;
        i += 12 + tlen;
    }
}

static int send_cmd(const unsigned char *c, int n) { return wr(tty, c, n); }

static int download(const char *name, int is_nvm) {
    char path[128];
    size_t len;
    snprintf(path, sizeof path, FW_DIR "%s", name);
    unsigned char *d = load(path, &len);
    if (!d) return -1;
    int mode = 0;   // 0 = jedes Stueck quittiert
    if (is_nvm) patch_nvm(d, len);
    else if (len > 14) mode = d[14];
    logf_("lade %s (%zu Byte, Modus %d)", name, len, mode);
    size_t pos = 0;
    int k = 0;
    unsigned char cmd[SEG + 6];
    while (pos < len) {
        int n = len - pos > SEG ? SEG : (int)(len - pos);
        int last = pos + n >= len || n < SEG;
        cmd[0] = 0x01; cmd[1] = 0x00; cmd[2] = 0xFC; cmd[3] = n + 2; cmd[4] = 0x1E; cmd[5] = n;
        memcpy(cmd + 6, d + pos, n);
        if (send_cmd(cmd, n + 6)) { free(d); return -1; }
        if (mode == 0 || last) {
            unsigned char ev[16];
            int r = wait_vse(0x04, ev, sizeof ev, 2000);   // 04 FF 03 00 04 <ergebnis>
            if (r < 0) { logf_("%s: keine Quittung fuer Stueck %d", name, k); free(d); return -1; }
            if (r >= 5 && ev[4]) logf_("%s: Stueck %d Ergebnis 0x%02x", name, k, ev[4]);
            // the controller may send another Command Complete afterwards -> skipped on the next wait
        }
        pos += n; k++;
    }
    free(d);
    logf_("%s: %d Stuecke gesendet", name, k);
    return 0;
}

static void power_off(void) {
    if (tty >= 0) {
        ioctl(tty, TIOCPMPUT);
        close(tty); tty = -1;
    }
    if (pw >= 0) {
        ioctl(pw, BT_CMD_PWR_CTRL, 0);
        close(pw); pw = -1;
    }
}

static int bringup(void) {
    unsigned char ev[64];
    pw = open("/dev/btpower", O_RDWR | O_CLOEXEC);
    if (pw < 0 || ioctl(pw, BT_CMD_PWR_CTRL, 1) < 0) { logf_("btpower: %s", strerror(errno)); return -1; }
    usleep(100000);
    tty = open("/dev/ttyHS0", O_RDWR | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
    if (tty < 0) { logf_("ttyHS0: %s", strerror(errno)); return -1; }
    ioctl(tty, TIOCPMGET);
    unsigned char off = 0xC0, on = 0xFC;
    port(B2400, 0); wr(tty, &off, 1); tcdrain(tty); usleep(10000);
    port(B115200, 0); wr(tty, &on, 1); tcdrain(tty); usleep(100000);
    tcflush(tty, TCIOFLUSH); rxn = 0;
    port(B115200, 1);

    static const unsigned char ver[] = {0x01, 0x00, 0xFC, 0x01, 0x19};
    send_cmd(ver, sizeof ver);
    int n = wait_vse(0x02, ev, sizeof ev, 1500);   // FF 0E 00 02 product patch rom soc
    if (n < 16) { logf_("keine Versionsantwort"); return -1; }
    unsigned rom = ev[10] | ev[11] << 8;
    unsigned soc = ev[12] | ev[13] << 8 | ev[14] << 16 | (unsigned)ev[15] << 24;
    unsigned romv = ((rom & 0xf000) >> 7) | (rom & 0xf);   // WCN3998-Formel (btqca 2026)
    logf_("Chip SoC 0x%08x ROM 0x%04x -> Firmware %02x", soc, rom, romv);
    usleep(150000); rxn = 0; tcflush(tty, TCIFLUSH);   // nachlaufendes Command Complete verwerfen

    // 3 Mbaud: command without flow control, then switch the host, wait for one vendor event
    static const unsigned char baud[] = {0x01, 0x48, 0xFC, 0x01, BAUD_3M_IDX};
    port(B115200, 0);
    send_cmd(baud, sizeof baud); tcdrain(tty); usleep(10000);
    port(B3000000, 1);
    n = next_event(ev, sizeof ev, 300);
    logf_("3 Mbaud: %s", n > 0 ? "Bestaetigung erhalten" : "keine Bestaetigung (weiter)");

    char fw[32], nvm[32];
    snprintf(fw, sizeof fw, "crbtfw%02x.tlv", romv);
    snprintf(nvm, sizeof nvm, "crnv%02x.bin", romv);
    if (download(fw, 0)) return -1;
    usleep(10000);
    if (download(nvm, 1)) return -1;

    static const unsigned char rst[] = {0x01, 0x03, 0x0C, 0x00};
    send_cmd(rst, sizeof rst);
    int st = wait_cc(0x0C03, 3000);
    logf_("HCI_Reset: %s", st == 0 ? "ok" : "fehlgeschlagen");
    if (st != 0) return -1;
    static const unsigned char rdaddr[] = {0x01, 0x09, 0x10, 0x00};
    send_cmd(rdaddr, sizeof rdaddr);
    unsigned char e2[64];
    long long end = now_ms() + 1000;
    while (now_ms() < end && (n = next_event(e2, sizeof e2, 500)) > 0) {
        if (e2[0] == 0x0E && (e2[3] | e2[4] << 8) == 0x1009 && n >= 12) {
            logf_("BD-Adresse %02X:%02X:%02X:%02X:%02X:%02X", e2[11], e2[10], e2[9], e2[8], e2[7], e2[6]);
            break;
        }
    }
    return 0;
}

static int relay(void) {
    unsigned char b[1100];
    vh = open("/dev/vhci", O_RDWR | O_CLOEXEC);
    if (vh < 0) { logf_("/dev/vhci: %s", strerror(errno)); return -1; }
    static const unsigned char create[] = {0xFF, 0x00};
    if (wr(vh, create, 2)) { logf_("vhci anlegen: %s", strerror(errno)); return -1; }
    int n = read(vh, b, sizeof b);
    if (n >= 4 && b[0] == 0xFF) logf_("vhci: hci%d angelegt", b[2] | b[3] << 8);
    else logf_("vhci: unerwartete Antwort (%d Byte)", n);
    rxn = 0;
    while (!stop) {
        struct pollfd p[2] = {{.fd = tty, .events = POLLIN}, {.fd = vh, .events = POLLIN}};
        if (poll(p, 2, 1000) < 0) { if (errno == EINTR) continue; break; }
        if (p[0].revents & POLLIN) {
            int r = read(tty, rx + rxn, sizeof rx - rxn);
            if (r > 0) rxn += r;
            int l;
            while (rxn > 0 && (l = frame_len(rx, rxn)) != 0) {
                if (l < 0) {
                    if (rx[0] == 0xFD) { unsigned char a = 0xFC; wr(tty, &a, 1); }
                    rx_drop(1);
                    continue;
                }
                if (wr(vh, rx, l)) logf_("vhci schreiben: %s", strerror(errno));
                rx_drop(l);
            }
            if (rxn == sizeof rx) { logf_("UART-Puffer voll, verworfen"); rxn = 0; }
        }
        if (p[1].revents & POLLIN) {
            int r = read(vh, b, sizeof b);
            if (r > 0) wr(tty, b, r);
            else if (r == 0) break;
        }
        if ((p[0].revents | p[1].revents) & (POLLERR | POLLHUP)) { logf_("Verbindung beendet"); break; }
    }
    close(vh); vh = -1;
    return 0;
}

int main(void) {
    signal(SIGTERM, on_sig);
    signal(SIGINT, on_sig);
    signal(SIGPIPE, SIG_IGN);
    // at system start wait up to 120 s for the ADSP (duo-audio starts it); otherwise do not start at all
    for (int i = 0; !adsp_online(); i++) {
        if (i >= 120 || stop) {
            logf_("ADSP nicht ONLINE -> kein Start (Bluetooth gegen totes ADSP blockiert den Kernel)");
            return 2;
        }
        sleep(1);
    }
    int rc = bringup();
    if (rc == 0) rc = relay();
    power_off();
    logf_("Ende (%d)", rc);
    return rc ? 1 : 0;
}
