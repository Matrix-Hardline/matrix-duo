// duo-haptik: short vibration pulse per keystroke for the Surface Duo (da7280). Own code.
// The downstream driver only accepts FF_CONSTANT (FF_RUMBLE -> EFAULT, «waveform != FF_CUSTOM», test 31.10.2026).
// Upload the effect ONCE (uploading again during playback -> EBUSY), play it per datagram on
// /run/duo/haptik.sock and stop it explicitly after <ms> (the driver does not honour the length itself).
// Datagram content optional: "<ms> <strength 0..32767>", otherwise 12 ms / 0x5000.
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <dirent.h>
#include <poll.h>
#include <time.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <linux/input.h>

#define SOCK "/run/duo/haptik.sock"

static int find_dev(void) {
    DIR *d = opendir("/dev/input");
    struct dirent *e;
    if (!d) return -1;
    while ((e = readdir(d))) {
        if (strncmp(e->d_name, "event", 5)) continue;
        char p[64], name[128] = {0};
        snprintf(p, sizeof p, "/dev/input/%s", e->d_name);
        int fd = open(p, O_RDWR | O_CLOEXEC);
        if (fd < 0) continue;
        if (ioctl(fd, EVIOCGNAME(sizeof name), name) >= 0 && strstr(name, "haptic")) {
            closedir(d);
            fprintf(stderr, "duo-haptik: %s (%s)\n", p, name);
            return fd;
        }
        close(fd);
    }
    closedir(d);
    return -1;
}

static long long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000LL + ts.tv_nsec / 1000000;
}

static int upload(int fd, struct ff_effect *ef, int level) {
    memset(ef, 0, sizeof *ef);
    ef->type = FF_CONSTANT;
    ef->id = -1;
    ef->u.constant.level = level;
    ef->replay.length = 0;
    return ioctl(fd, EVIOCSFF, ef);
}

static void play(int fd, int id, int on) {
    struct input_event ev = {0};
    ev.type = EV_FF;
    ev.code = id;
    ev.value = on;
    if (write(fd, &ev, sizeof ev) != sizeof ev)
        fprintf(stderr, "duo-haptik: Abspielen: %s\n", strerror(errno));
}

int main(void) {
    int fd = find_dev();
    if (fd < 0) { fprintf(stderr, "duo-haptik: kein Haptik-Geraet\n"); return 1; }
    struct ff_effect ef;
    int level = 0x5000;
    if (upload(fd, &ef, level) < 0) { perror("EVIOCSFF"); return 1; }

    mkdir("/run/duo", 0755);
    unlink(SOCK);
    int s = socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    struct sockaddr_un a = {.sun_family = AF_UNIX};
    strncpy(a.sun_path, SOCK, sizeof a.sun_path - 1);
    if (s < 0 || bind(s, (struct sockaddr *)&a, sizeof a) < 0) { perror("bind"); return 1; }
    chmod(SOCK, 0666);
    fprintf(stderr, "duo-haptik: bereit auf %s (Effekt %d)\n", SOCK, ef.id);

    long long stop_at = 0;
    for (;;) {
        int to = -1;
        if (stop_at) { long long d = stop_at - now_ms(); to = d < 0 ? 0 : (int)d; }
        struct pollfd pf = {.fd = s, .events = POLLIN};
        int r = poll(&pf, 1, to);
        if (r < 0) { if (errno == EINTR) continue; break; }
        if (stop_at && now_ms() >= stop_at) { play(fd, ef.id, 0); stop_at = 0; }
        if (r == 0) continue;
        char buf[64] = {0};
        ssize_t n = recv(s, buf, sizeof buf - 1, 0);
        if (n < 0) continue;
        int ms = 12, lv = level;
        if (n > 0) sscanf(buf, "%d %d", &ms, &lv);
        if (ms < 1) ms = 1;
        if (ms > 100) ms = 100;          // LatinIME slider limit
        if (lv != level && lv > 0 && lv <= 32767) {
            play(fd, ef.id, 0);
            ioctl(fd, EVIOCRMFF, ef.id);
            level = lv;
            if (upload(fd, &ef, level) < 0) { perror("EVIOCSFF"); continue; }
        }
        play(fd, ef.id, 1);
        stop_at = now_ms() + ms;
    }
    return 0;
}
