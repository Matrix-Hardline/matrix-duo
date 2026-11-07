// Kurztest Haptik Surface Duo (da7280): Effekt hochladen und abspielen, Rueckgabewerte melden. Eigener Code.
#include <stdio.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <sys/ioctl.h>
#include <linux/input.h>
static int play(int fd, struct ff_effect *e, int ms, const char *name) {
  e->id = -1;
  if (ioctl(fd, EVIOCSFF, e) < 0) { printf("%s: EVIOCSFF fehlgeschlagen: %s\n", name, strerror(errno)); return -1; }
  struct input_event ev = {0}; ev.type = EV_FF; ev.code = e->id; ev.value = 1;
  if (write(fd, &ev, sizeof ev) != sizeof ev) { printf("%s: Abspielen fehlgeschlagen: %s\n", name, strerror(errno)); return -1; }
  usleep(ms * 1000);
  ev.value = 0; write(fd, &ev, sizeof ev);
  printf("%s: ok (id %d)\n", name, e->id);
  usleep(400000);
  ioctl(fd, EVIOCRMFF, e->id);
  return 0;
}
int main(int argc, char **argv) {
  const char *dev = argc > 1 ? argv[1] : "/dev/input/event1";
  int fd = open(dev, O_RDWR); if (fd < 0) { perror(dev); return 1; }
  int n = 0; if (ioctl(fd, EVIOCGEFFECTS, &n) == 0) printf("gleichzeitige Effekte: %d\n", n);
  struct ff_effect e;
  memset(&e, 0, sizeof e); e.type = FF_RUMBLE; e.u.rumble.strong_magnitude = 0xC000; e.replay.length = 15;
  play(fd, &e, 15, "rumble 15 ms");
  memset(&e, 0, sizeof e); e.type = FF_CONSTANT; e.u.constant.level = 0x6000; e.replay.length = 15;
  play(fd, &e, 15, "constant 15 ms");
  memset(&e, 0, sizeof e); e.type = FF_RUMBLE; e.u.rumble.strong_magnitude = 0xFFFF; e.replay.length = 300;
  play(fd, &e, 300, "rumble 300 ms (deutlich spuerbar)");
  close(fd); return 0;
}
