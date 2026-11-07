/* duo-powerkey (niri version v5, 05.11.2026: locks; v4 03.11.2026): power key of the Surface Duo 1.
 * v3 spoke Mutter's PowerSaveMode — niri does not know it ("Connection support is lacking"), so every press fell back
 * to plain bl_power: only the light went off, rendering and apps kept running, touch stayed live
 * (pocket), and the posture service pulled the brightness back up ("not reliable", the owner).
 *   Press while on : mute touch on both panels (/run/duo/mute-A|B, duoheat), niri power-off-monitors (DRM off).
 *   Press while off: niri power-on-monitors, undo only the mute we set OURSELVES (the posture service's
 *                    in one-panel mode stays).
 * State: /run/duo/aus (present = panels off). A touch does not wake (muted); keys wake niri by themselves —
 * then the next press counts as "off".
 * Without a session (login screen/no niri of the user): fall back to bl_power like v3. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <linux/input.h>
#include <pwd.h>

static const char *BL[2] = {"/sys/class/backlight/panel0-backlight/brightness", "/sys/class/backlight/panel1-backlight/brightness"};
static const char *BP[2] = {"/sys/class/backlight/panel0-backlight/bl_power", "/sys/class/backlight/panel1-backlight/bl_power"};
static const char *MUTE[2] = {"/run/duo/mute-A", "/run/duo/mute-B"};
static const char *OWN[2] = {"/run/duo/aus-mute-A", "/run/duo/aus-mute-B"};
#define STATE "/run/duo/aus"
/* v5.5 (05.11.2026): the desk — folded shut with a screen on USB-C (duo-haltung). The panels stay dark and deaf;
 * the key sleeps and wakes the SCREEN (and locks), never lights the closed panels. */
#define DESK "/run/duo/schreibtisch"
/* niri of the person's session: the newest socket in /run/user/1000 */
/* v5.5 (06.11.2026, freshly installed Duo: no lock, screens stayed on): the person is the first account (uid 1000)
 * — whatever it is called. «mobile» was the workshop Duo's name; on a Duo set up by Morpheus `runuser -u mobile`
 * failed, so niri never got the lock or the screens-off command. Looked up on every press (the service starts
 * before the first setup creates the account). */
#define NIRI "runuser -u '%s' -- sh -c 'export XDG_RUNTIME_DIR=/run/user/1000; S=$(ls -t /run/user/1000/niri.*.sock 2>/dev/null | head -1); [ -n \"$S\" ] && NIRI_SOCKET=$S timeout 5 niri msg action %s'"
static int person(char *name, size_t nn, char *home, size_t hn) {
  struct passwd *p = getpwuid(1000);
  if (!p || !p->pw_name || !p->pw_dir) return 0;
  snprintf(name, nn, "%s", p->pw_name);
  snprintf(home, hn, "%s", p->pw_dir);
  return 1;
}
/* ~/.config/matrix/<key> of the person */
static FILE *setting(const char *key) {
  char name[64], home[256], path[400];
  if (!person(name, sizeof name, home, sizeof home)) return NULL;
  snprintf(path, sizeof path, "%s/.config/matrix/%s", home, key);
  return fopen(path, "r");
}

static int exists(const char *p) { return access(p, F_OK) == 0; }
static void touch(const char *p) { int f = open(p, O_WRONLY | O_CREAT, 0644); if (f >= 0) close(f); }
/* v5.4 (05.11.2026): «dark» = BOTH backlights off. Folded with DSI-2 in
 * front, panel0 is the back panel and dark on purpose — reading panel0
 * alone made every press a «wake» (the Duo woke itself again). */
static int bl_power_one(int i) { FILE *f = fopen(BP[i], "r"); int v = 0; if (f) { if (fscanf(f, "%d", &v) != 1) v = 0; fclose(f); } return v; }
static int bl_power_get(void) { return (bl_power_one(0) != 0 && bl_power_one(1) != 0) ? 4 : 0; }
static void bl_power_set(int v) { for (int i = 0; i < 2; i++) { FILE *f = fopen(BP[i], "w"); if (f) { fprintf(f, "%d", v); fclose(f); } } }
static void bl_set(int v) { for (int i = 0; i < 2; i++) { FILE *f = fopen(BL[i], "w"); if (f) { fprintf(f, "%d", v); fclose(f); } } }
static int niri(const char *action) {
  char name[64], home[256], c[768];
  if (!person(name, sizeof name, home, sizeof home)) return 0;
  for (const char *q = name; *q; q++) if (*q == '\'') return 0;   /* never quote-break the shell line */
  snprintf(c, sizeof c, NIRI, name, action);
  return system(c) == 0;
}

/* Is any display pipe still running? (DRM state: an active CRTC) */
static int crtc_active(void) {
  FILE *f = fopen("/sys/kernel/debug/dri/0/state", "r");
  if (!f) return -1;
  char line[256]; int on = 0;
  while (fgets(line, sizeof line, f)) if (strstr(line, "active=1")) on = 1;
  fclose(f);
  return on;
}

/* v5 (05.11.2026): the power key LOCKS like a phone — niri starts the
 * lock screen in the session (its environment), then the panels go dark;
 * waking shows the lock. Off in the settings (lock-on-power = off); never
 * a second lock over a running one. */
static int lock_wanted(void) {
  char v[16] = "";
  FILE *f = setting("lock-on-power");
  if (f) { if (fgets(v, sizeof v, f) == NULL) v[0] = 0; fclose(f); }
  if (strncmp(v, "off", 3) == 0) return 0;
  return system("pgrep -x matrix-lock >/dev/null 2>&1") != 0;
}

static void panels_off(void) {
  for (int i = 0; i < 2; i++) if (!exists(MUTE[i])) { touch(MUTE[i]); touch(OWN[i]); }
  /* v4.1 (03.11.2026): niri also sees the power key — a late event of the
   * same press woke the panels a second after (measured: off 14:42:46, on
   * 14:42:47, no other input). Let the press settle, then switch off, and
   * check it stayed off (twice at most). */
  usleep(600000);
  if (lock_wanted() && niri("spawn -- /usr/local/bin/matrix-lock")) {
    fprintf(stderr, "duo-powerkey: Sperre gestartet\n");
    usleep(500000);                          /* the lock covers before the dark */
  }
  if (niri("power-off-monitors")) {
    touch(STATE);
    for (int t = 0; t < 2; t++) {
      usleep(1500000);
      if (!exists(STATE)) return;            /* switched on again by a press meanwhile */
      if (crtc_active() == 1) { fprintf(stderr, "duo-powerkey: wieder an — nochmals aus\n"); niri("power-off-monitors"); }
      else break;
    }
    fprintf(stderr, "duo-powerkey: Panels aus (niri), Beruehrung stumm\n");
    return;
  }
  /* no session: undo the mute, fall back to the backlight */
  for (int i = 0; i < 2; i++) if (exists(OWN[i])) { unlink(MUTE[i]); unlink(OWN[i]); }
  fprintf(stderr, "duo-powerkey: (keine Sitzung) nur Licht aus\n");
  bl_power_set(4);
}

/* v5.1 (05.11.2026): «dsi FIFO UNDERFLOW» from the display driver = the
 * panels woke in the wrong order (noise on both, until a full cycle). */
static int underflows(void) {
  int n = 0;
  FILE *p = popen("dmesg 2>/dev/null | grep -c 'FIFO UNDERFLOW'", "r");
  if (p) { if (fscanf(p, "%d", &n) != 1) n = 0; pclose(p); }
  return n;
}

/* v5.2 (05.11.2026): folded (one panel, /run/duo/single names the front),
 * the back panel is switched off on its own (niri 0017) — waking only the
 * front alone gave noise (owner: «noise, unfolding helped»). So wake BOTH
 * together like unfolding does (first-light order), then switch the back
 * one off again. */
static int folded_back(char *back, size_t n) {
  char front[16] = "";
  FILE *f = fopen("/run/duo/single", "r");
  if (!f) return 0;
  if (fgets(front, sizeof front, f) == NULL) front[0] = 0;
  fclose(f);
  front[strcspn(front, "\r\n")] = 0;
  if (strcmp(front, "DSI-1") == 0) snprintf(back, n, "DSI-2");
  else if (strcmp(front, "DSI-2") == 0) snprintf(back, n, "DSI-1");
  else return 0;
  return 1;
}

static void panels_on(void) {
  int before = underflows();
  char back[16], act[64];
  int folded = folded_back(back, sizeof back);
  if (folded) {
    snprintf(act, sizeof act, "power-on-monitor %s", back);
    niri(act);                               /* back in the set, woken together */
  }
  niri("power-on-monitors");
  for (int i = 0; i < 2; i++) if (exists(OWN[i])) { unlink(MUTE[i]); unlink(OWN[i]); }
  /* v5.3: folded, the back panel stays deaf to touch — the posture service
   * may have switched to one panel while the panels were off, and our own
   * marks then lifted ITS mute too (back panel answered touches). */
  { char back[16];
    if (folded_back(back, sizeof back)) touch(strcmp(back, "DSI-1") == 0 ? MUTE[0] : MUTE[1]); }
  unlink(STATE);
  if (exists(DESK)) {
    for (int i = 0; i < 2; i++) touch(MUTE[i]);
    fprintf(stderr, "duo-powerkey: Schreibtisch — Bildschirm an, Panels bleiben dunkel\n");
    return;
  }
  if (bl_power_get() != 0) { bl_power_set(0); bl_set(180); }
  fprintf(stderr, "duo-powerkey: Panels an\n");
  if (folded) {
    usleep(2000000);
    char v[8] = "";
    FILE *f = setting("back-panel-off");
    if (f) { if (fgets(v, sizeof v, f) == NULL) v[0] = 0; fclose(f); }
    /* still on, and the back panel is meant to be fully off (settings) */
    if (exists(STATE) == 0 && strncmp(v, "on", 2) == 0) {
      snprintf(act, sizeof act, "power-off-monitor %s", back);
      niri(act);
      fprintf(stderr, "duo-powerkey: zugeklappt — beide geweckt, hinteres %s wieder aus\n", back);
    }
  }
  /* Self-heal: noise after waking (one panel folded away woke first) —
   * all off and on once more, the proven way of the second press. */
  usleep(2000000);
  if (underflows() - before >= 3) {
    fprintf(stderr, "duo-powerkey: Panels rauschen — alle aus und wieder an\n");
    niri("power-off-monitors");
    usleep(1500000);
    niri("power-on-monitors");
  }
}

int main(int argc, char **argv) {
  const char *dev = argc > 1 ? argv[1] : "/dev/input/event0";
  int fd = open(dev, O_RDONLY);
  if (fd < 0) { perror(dev); return 1; }
  mkdir("/run/duo", 0755);
  /* a stale "off" from a crash: the panels are on at start */
  if (exists(STATE)) panels_on();
  fprintf(stderr, "duo-powerkey v4 (niri): lausche auf %s\n", dev);
  struct input_event e;
  while (read(fd, &e, sizeof e) == sizeof e) {
    if (e.type != EV_KEY || e.code != KEY_POWER || e.value != 0) continue;
    if (exists(STATE) || (!exists(DESK) && bl_power_get() != 0)) panels_on();
    else panels_off();
  }
  return 0;
}
