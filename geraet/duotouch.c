// duotouch: Surface Duo touch (spi-hid 045E:0C01) -> two uinput touchscreens (one per panel). Own code.
// Reports 0x42/0x40: byte0 bit0 = tip, u16 X, u16 Y (0..32767). Axes per panel by argument: "xy", "yx" (swap), suffix i/j = invert X/Y.
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <poll.h>
#include <time.h>
#include <signal.h>
#include <math.h>
#include <sys/stat.h>
#include <sys/ioctl.h>
#include <linux/uinput.h>
#include <linux/input.h>
#define MAXV 32767
#define RAW_XMIN 820
#define RAW_XMAX 31948
#define RAW_YMIN 630
#define RAW_YMAX 32136
#define CAL_A { 0.0407184, -0.0004932, -9.017,  0.0000634, 0.0537005, 3.117 }   /* grid 30.10., panel A, 2 measurement series (24 points), residual 17 px */
#define CAL_B { 0.0396948, -0.0005433, 14.852,  0.0002141, 0.0538218, 1.473 }   /* grid 30.10., panel B (12 points), residual 11 px */
/* Debouncing (measurement 30.10. 21:30, werkzeuge/touch-aussetzer.py): in the middle of a movement the controller reports
 * Tip=0 once and then stays silent for 40..200 ms; 18 of 45 touches on panel B were such dropouts. A Tip=0 is
 * therefore only passed on as a release after HOLD_UP_MS without a new report; if the finger comes back close
 * (< JUMP_RAW) within that time, the same touch continues. A far jump = a real new finger. */
#define HOLD_UP_MS 150
/* The finger was last moving (scrolling/swiping): dropouts of up to 200 ms measured -> wait longer, otherwise
 * a scroll falls apart into two touches and the short tail acts like a tap (Iotas opened the keyboard, 01.11.) */
#define HOLD_UP_MOVING_MS 70
/* Gliding (01.11.): when a MOVING finger lifts, the reported position keeps going at the last velocity until
 * the release is reported. Before, it stood still for 230 ms -> GTK measured velocity 0 at release and did not let the
 * list coast («it's stuck»). Hence the wait for moving fingers is now only 70 ms; longer dropouts
 * in the middle of a swipe are caught by the shell (edge-swipe continuation) and the keyboard lock (scroll fragments). */
#define GLIDE_TICK_MS 8
/* «In motion» = smoothed velocity, not the last report: shortly before lifting the sensor reports only
 * crumbs (recording 01.11.: last movement 180-190 ms before release, gliding never kicked in). 8 raw/ms ~ 115 log. px/s */
#define GLIDE_MIN_V 8.0
/* Short contact (01.11., tipplog): when touching down for a swipe the sensor often loses the finger after just ~40 ms and
 * finds it again 40-130 ms later further away -> the fragment was released at once as a tap («I tap while
 * scrolling»). Contacts under SHORT_TAP_MS therefore wait SHORT_HOLD_MS; if the finger returns, it is the same swipe. */
#define SHORT_TAP_MS 60
#define SHORT_HOLD_MS 140
/* Second measurement 01.11. 12:52: false taps also with 70-190 ms duration, when the finger had already travelled 500-890 raw and
 * the sensor reported it still just before the dropout (last 0); return after 120-130 ms. A tap that already
 * travelled noticeably is therefore «uncertain» and also waits SHORT_HOLD_MS (afterwards it is still fired as a tap at
 * the touch-down point). Only a still tap (< SURE_TAP_RAW) fires immediately. */
#define SURE_TAP_RAW 350
#define JUMP_RAW 6000
/* Tapping (31.10.): the debouncing merged fast taps -- if the next finger touched down within 150 ms up to
 * ~2 keys away, the old touch continued and the letter was lost (neighbouring keys, double letters).
 * Dropouts only came IN THE MIDDLE OF MOVEMENTS; a short, still tap is therefore released immediately. */
#define TAP_MS 350
#define TAP_MOVE_RAW 900
/* ...but only if the finger was last standing still (movement between the last two reports < TAP_STILL_RAW).
 * Otherwise it is a dropout at the start of a swipe (31.10. 22:00: edge swipe stopped at ~13 px, overview
 * jumped back). Taps: total movement median 194, 97 % < 604 (245 taps). */
#define TAP_STILL_RAW 60
/* Two thumbs (31.10. evening, tipplog «der schnelle braune fuchs springt» -> 4 letters lost, mostly after the space bar):
 * the controller knows only ONE finger. If the second thumb touches down while the first is still down, the reported
 * position merely jumps -- that counted as the same touch slipping. A jump > NEW_FINGER_RAW between two reports
 * (~8 ms; real slipping stays far below) is a new finger: release the old touch, begin a new one.
 * Touching down again after a dropout counts as a new finger from REDOWN_RAW on (before 6000, finding: 1071 after 40 ms). */
#define NEW_FINGER_RAW 600
#define REDOWN_RAW 900
/* Slop zone (31.10., Iotas menu): GTK treats a tap as a drag as soon as the finger travels ~7 logical px (probe:
 * 20 device pixels of wobble -> menu entry does not react, 10 -> works). A real finger travels more when touching down/lifting.
 * Until the touch is SLOP_RAW (~28 device pixels, ~10 logical px) away from the touch-down point, the
 * touch-down point is therefore reported (like Android's «touch slop»); after that the real position. */
#define SLOP_RAW 700
struct panel { int fd; int rid; int swap, invx, invy; int w, h; int down; const char *name; int pid; double cal[6];
               int pending_up; long long up_at; int lrx, lry;
               long long t_down; int srx, sry, moved, lastd, nrep; double offx, offy; int slopped;
               long long last_t, glide_t; double vx, vy, gx, gy; int glide, short_up; };
static volatile sig_atomic_t term;
static void on_term(int s){ (void)s; term=1; }
static long long now_ms(void){ struct timespec ts; clock_gettime(CLOCK_MONOTONIC,&ts); return ts.tv_sec*1000LL+ts.tv_nsec/1000000; }
static void emit(int fd,int t,int c,int v){ struct input_event e={0}; e.type=t; e.code=c; e.value=v; write(fd,&e,sizeof e); }
static int mk_uinput(struct panel *p){
  int fd=open("/dev/uinput",O_WRONLY|O_NONBLOCK); if(fd<0){perror("/dev/uinput");return -1;}
  ioctl(fd,UI_SET_EVBIT,EV_ABS); ioctl(fd,UI_SET_EVBIT,EV_KEY); ioctl(fd,UI_SET_EVBIT,EV_SYN);
  ioctl(fd,UI_SET_KEYBIT,BTN_TOUCH); ioctl(fd,UI_SET_PROPBIT,INPUT_PROP_DIRECT);
  int codes[]={ABS_X,ABS_Y,ABS_MT_POSITION_X,ABS_MT_POSITION_Y,ABS_MT_SLOT,ABS_MT_TRACKING_ID};
  for(unsigned i=0;i<sizeof codes/sizeof *codes;i++) ioctl(fd,UI_SET_ABSBIT,codes[i]);
  struct uinput_user_dev ud={0}; snprintf(ud.name,sizeof ud.name,"%s",p->name); ud.id.bustype=BUS_SPI; ud.id.vendor=0x045e; ud.id.product=p->pid; /* own product id per panel, so that Mutter can map them separately */ ud.id.version=1;
  ud.absmax[ABS_X]=ud.absmax[ABS_MT_POSITION_X]=p->w-1; ud.absmax[ABS_Y]=ud.absmax[ABS_MT_POSITION_Y]=p->h-1;
  ud.absmax[ABS_MT_SLOT]=0; ud.absmax[ABS_MT_TRACKING_ID]=65535;
  if(write(fd,&ud,sizeof ud)<0){perror("uinput dev");return -1;}
  if(ioctl(fd,UI_DEV_CREATE)){perror("UI_DEV_CREATE");return -1;}
  p->fd=fd; p->down=0; return 0;
}
static void up_now(struct panel *p){
  if(!p->down) return;
  emit(p->fd,EV_ABS,ABS_MT_SLOT,0); emit(p->fd,EV_ABS,ABS_MT_TRACKING_ID,-1); emit(p->fd,EV_KEY,BTN_TOUCH,0); p->down=0; p->pending_up=0;
  emit(p->fd,EV_SYN,SYN_REPORT,0);
}
static void to_dev(struct panel *p,int rx,int ry,int *ox,int *oy){
  int x = p->swap ? ry : rx, y = p->swap ? rx : ry;
  if(p->invx) x=MAXV-x; if(p->invy) y=MAXV-y;
  double fx = p->cal[0]*x + p->cal[1]*y + p->cal[2];
  double fy = p->cal[3]*x + p->cal[4]*y + p->cal[5];
  x = (int)(fx + 0.5); y = (int)(fy + 0.5);
  if(x<0) x=0; if(x>p->w-1) x=p->w-1; if(y<0) y=0; if(y>p->h-1) y=p->h-1;
  *ox=x; *oy=y;
}
/* during the wait of a moving finger: carry the position on at the last velocity */
static void glide_step(struct panel *p,long long t){
  if(!p->glide || !p->pending_up || !p->down) return;
  double dt = (double)(t - p->glide_t); if(dt <= 0) return;
  p->glide_t = t; p->gx += p->vx*dt; p->gy += p->vy*dt;
  int x,y; to_dev(p,(int)p->gx,(int)p->gy,&x,&y);
  emit(p->fd,EV_ABS,ABS_MT_POSITION_X,x); emit(p->fd,EV_ABS,ABS_MT_POSITION_Y,y); emit(p->fd,EV_ABS,ABS_X,x); emit(p->fd,EV_ABS,ABS_Y,y);
  emit(p->fd,EV_SYN,SYN_REPORT,0);
}
static void handle(struct panel *p,int tip,int rx,int ry){
  if(!tip){                               /* release only after HOLD_UP_MS without a new report (see above) */
    if(p->down && !p->pending_up){
      long long dur=now_ms()-p->t_down;
      double sp = fabs(p->vx) + fabs(p->vy);
      if((dur<SHORT_TAP_MS || p->moved>=SURE_TAP_RAW) && p->moved<TAP_MOVE_RAW && p->lastd<TAP_STILL_RAW && sp<GLIDE_MIN_V){
        if(!access("/run/duo/tipplog",F_OK)) fprintf(stderr,"unsicher %s %lld ms weg %d\n",p->name+18,dur,p->moved);
        p->pending_up=1; p->up_at=now_ms()+SHORT_HOLD_MS; p->glide=0; p->short_up=1; return; }
      if(dur<TAP_MS && p->moved<TAP_MOVE_RAW && p->lastd<TAP_STILL_RAW && sp<GLIDE_MIN_V){ if(!access("/run/duo/tipplog",F_OK)) fprintf(stderr,"tipp %s %lld ms weg %d zuletzt %d\n",p->name+18,dur,p->moved,p->lastd); up_now(p); return; }
      int fahrt = (p->lastd>=TAP_STILL_RAW || sp>=GLIDE_MIN_V) && p->moved>=SLOP_RAW;
      p->pending_up=1; p->up_at=now_ms()+(fahrt?HOLD_UP_MOVING_MS:HOLD_UP_MS);
      /* glide only if the finger really dragged (not when tapping in place) */
      p->glide = fahrt;
      p->glide_t = now_ms(); p->gx = p->lrx - p->offx; p->gy = p->lry - p->offy; }
    return;
  }
  if(p->pending_up){                      /* finger back: near = same touch, far = new finger */
    p->pending_up=0; p->glide=0;
    int j=abs(rx-p->lrx)+abs(ry-p->lry);
    if(!access("/run/duo/tipplog",F_OK)) fprintf(stderr,"wieder %s nach %lld ms sprung %d -> %s\n",p->name+18,now_ms()-(p->up_at-HOLD_UP_MS),j,j>REDOWN_RAW?"neu":"fortsetzung");
    /* Fast swipe (01.11. 12:54: «back after 80-120 ms, jump 5000 -> new» cut swipes apart, the new start
     * became a false tap): if the jump matches the last velocity, it is the same finger. */
    long long gap = now_ms() - p->last_t;
    double erwartet = (fabs(p->vx) + fabs(p->vy)) * (double)gap;
    if(p->short_up) p->short_up=0;         /* short contact: the same finger, even if it travelled far */
    else if(j > REDOWN_RAW && j > 2.0*erwartet + REDOWN_RAW){ up_now(p); p->lrx=rx; p->lry=ry; return; }
  } else if(p->down && p->nrep >= 2 && !access("/run/duo/frei/tastatur",F_OK) && abs(rx-p->lrx)+abs(ry-p->lry) > NEW_FINGER_RAW
            && abs(rx-p->lrx)+abs(ry-p->lry) > 3*p->lastd+400){   /* second thumb touches down (sudden jump from
     * a still position; only with the on-screen keyboard open, marker of the shell extension; a fast swipe moves evenly and must not be cut apart, 31.10. 22:03).
     * Only from the 3rd report of a touch on: before that «lastd» is still 0, and a finger that touches down from the edge
     * already moving was cut apart report by report (cascade 22:04, edge swipe only from the line on). */
    if(!access("/run/duo/tipplog",F_OK)) fprintf(stderr,"zweiter Finger %s sprung %d\n",p->name+18,abs(rx-p->lrx)+abs(ry-p->lry));
    up_now(p);
    /* Begin the new contact only with the NEXT report (~8 ms): release + immediate touch-down in the same
     * instant made Mutter crash (31.10. 21:33, meta_seat_impl_acquire_touch_state_in_impl: contact slot
     * still occupied -> «Bail out», session gone). */
    p->lrx=rx; p->lry=ry;
    return;
  }
  p->lastd = p->down ? abs(rx-p->lrx)+abs(ry-p->lry) : 0;
  {
    long long t = now_ms(), dt = t - p->last_t;
    if(p->down && dt > 0 && dt < 120){
      p->vx = 0.6*p->vx + 0.4*(double)(rx-p->lrx)/dt; p->vy = 0.6*p->vy + 0.4*(double)(ry-p->lry)/dt;
    } else { p->vx = p->vy = 0; }
    p->last_t = t;
  }
  p->lrx=rx; p->lry=ry;
  if(!p->down){ p->t_down=now_ms(); p->srx=rx; p->sry=ry; p->moved=0; p->nrep=0; p->short_up=0; }
  else { int mv=abs(rx-p->srx)+abs(ry-p->sry); if(mv>p->moved) p->moved=mv; }
  p->nrep++;
  if(!p->down) p->slopped=0;
  if(p->down && p->moved<SLOP_RAW){ rx=p->srx; ry=p->sry; }   /* slop zone */
  else if(p->down){
    /* leaving the slop zone: do not jump by the whole zone (jerk at the start of every swipe), but work off the lag
     * over the next reports (halved per report) */
    if(!p->slopped){ p->slopped=1; p->offx=rx-p->srx; p->offy=ry-p->sry; }
    else { p->offx*=0.5; p->offy*=0.5; }
    rx-=(int)p->offx; ry-=(int)p->offy;
  }
  /* Grid calibration 30.10.2026 (werkzeuge/kalib2.py + kalib2-fit.py, 12 points per panel): affine mapping
   * raw -> device pixels (to_dev). The old stretch 820..31948 was off by up to 89 px (residual error ~15 px). */
  int x, y; to_dev(p, rx, ry, &x, &y);
  if(tip){ if(!p->down){ emit(p->fd,EV_ABS,ABS_MT_SLOT,0); emit(p->fd,EV_ABS,ABS_MT_TRACKING_ID,p->rid*1000+ (rand()&0x3ff)); emit(p->fd,EV_KEY,BTN_TOUCH,1); p->down=1; }
    emit(p->fd,EV_ABS,ABS_MT_POSITION_X,x); emit(p->fd,EV_ABS,ABS_MT_POSITION_Y,y); emit(p->fd,EV_ABS,ABS_X,x); emit(p->fd,EV_ABS,ABS_Y,y); }
  else if(p->down){ emit(p->fd,EV_ABS,ABS_MT_SLOT,0); emit(p->fd,EV_ABS,ABS_MT_TRACKING_ID,-1); emit(p->fd,EV_KEY,BTN_TOUCH,0); p->down=0; }
  emit(p->fd,EV_SYN,SYN_REPORT,0);
}
static void parse_axes(struct panel *p,const char *s){ p->swap = (s[0]=='y'); for(const char *c=s;*c;c++){ if(*c=='i') p->invx=1; if(*c=='j') p->invy=1; } }
int main(int argc,char**argv){
  // duotouch [hidraw] [axes-panelA (rid 0x42)] [axes-panelB (rid 0x40)]   default: /dev/hidraw0 xy xy ; panel size 1350x1800
  const char *dev=argc>1?argv[1]:"/dev/hidraw0";
  struct panel A={.rid=0x42,.w=1350,.h=1800,.name="Surface Duo Touch A",.pid=0x0c01,.cal=CAL_A}, B={.rid=0x40,.w=1350,.h=1800,.name="Surface Duo Touch B",.pid=0x0c02,.cal=CAL_B};
  parse_axes(&A,argc>2?argv[2]:"xy"); parse_axes(&B,argc>3?argv[3]:"xy");
  int hid=open(dev,O_RDONLY); if(hid<0){perror(dev);return 1;}
  if(mk_uinput(&A)||mk_uinput(&B)) return 1;
  /* marker directory the shell (user and login session) may write to */
  mkdir("/run/duo",0755); mkdir("/run/duo/frei",01777); chmod("/run/duo/frei",01777);
  fprintf(stderr,"duotouch: %s -> uinput A(0x42,%s) B(0x40,%s)\n",dev,argc>2?argv[2]:"xy",argc>3?argv[3]:"xy");
  unsigned char b[64]; int lastA=0,lastB=0; (void)lastA;(void)lastB;
  struct panel *ps[2]={&A,&B};
  /* Exit (service restart): first release all touches, then tear down the devices. If a device vanished
   * with a finger down, Mutter kept the contact slot; the next tap with the same slot number made the shell
   * crash (31.10. 21:33 and 21:47, each shortly after «systemctl restart duotouch»). */
  struct sigaction sa={0}; sa.sa_handler=on_term; sigaction(SIGTERM,&sa,NULL); sigaction(SIGINT,&sa,NULL);
  while(!term){
    int to=-1; long long t=now_ms();
    for(int i=0;i<2;i++) if(ps[i]->pending_up){ long long d=ps[i]->up_at-t; if(d<0) d=0;
      if(ps[i]->glide && d>GLIDE_TICK_MS) d=GLIDE_TICK_MS; if(to<0||d<to) to=(int)d; }
    struct pollfd pf={.fd=hid,.events=POLLIN};
    int r=poll(&pf,1,to);
    if(r<0){ if(errno==EINTR) continue; break; }
    if(term) break;
    t=now_ms();
    for(int i=0;i<2;i++){ if(ps[i]->pending_up && t<ps[i]->up_at) glide_step(ps[i],t);
                          if(ps[i]->pending_up && t>=ps[i]->up_at){ glide_step(ps[i],t); up_now(ps[i]); ps[i]->glide=0; } }
    if(r==0) continue;
    int n=read(hid,b,sizeof b); if(n<=0){ if(errno==EINTR) continue; break; }
    if(n<6) continue; int tip=b[1]&1; int x=b[2]|b[3]<<8, y=b[4]|b[5]<<8;
    /* diagnosis: /run/duo/touchlog present -> every raw report into the journal (report id, length, first bytes) */
    if(!access("/run/duo/touchlog",F_OK)){ fprintf(stderr,"touchlog n=%d",n); for(int i=0;i<n&&i<16;i++) fprintf(stderr," %02x",b[i]); fprintf(stderr,"\n"); }
    /* posture service: /run/duo/mute-A or mute-B mutes a panel (the rear panel when flipped) */
    if(b[0]==0x42){ if(access("/run/duo/mute-A",F_OK)) handle(&A,tip,x,y); else up_now(&A); }
    else if(b[0]==0x40){ if(access("/run/duo/mute-B",F_OK)) handle(&B,tip,x,y); else up_now(&B); } }
  up_now(&A); up_now(&B); usleep(100000);
  ioctl(A.fd,UI_DEV_DESTROY); ioctl(B.fd,UI_DEV_DESTROY);
  return 0; }
