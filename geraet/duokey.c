/* duokey: inject a key combination via /dev/uinput (e.g. Super+Shift+Right = window to the next monitor).
 * Usage: duokey KEY... (names: super shift ctrl alt left right up down enter esc tab f11) */
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <linux/uinput.h>

static int code(const char *n){
  if(!strcmp(n,"super")) return KEY_LEFTMETA; if(!strcmp(n,"shift")) return KEY_LEFTSHIFT; if(!strcmp(n,"ctrl")) return KEY_LEFTCTRL;
  if(!strcmp(n,"alt")) return KEY_LEFTALT; if(!strcmp(n,"left")) return KEY_LEFT; if(!strcmp(n,"right")) return KEY_RIGHT;
  if(!strcmp(n,"up")) return KEY_UP; if(!strcmp(n,"down")) return KEY_DOWN; if(!strcmp(n,"enter")) return KEY_ENTER;
  if(!strcmp(n,"esc")) return KEY_ESC; if(!strcmp(n,"tab")) return KEY_TAB; if(!strcmp(n,"f11")) return KEY_F11; if(!strcmp(n,"volumeup")) return KEY_VOLUMEUP; if(!strcmp(n,"volumedown")) return KEY_VOLUMEDOWN; return -1; }
static void emit(int fd,int t,int c,int v){ struct input_event e={0}; e.type=t; e.code=c; e.value=v; write(fd,&e,sizeof e); }
int main(int argc,char**argv){
  if(argc<2){ fprintf(stderr,"duokey KEY...\n"); return 1; }
  int fd=open("/dev/uinput",O_WRONLY|O_NONBLOCK); if(fd<0){ perror("/dev/uinput"); return 1; }
  ioctl(fd,UI_SET_EVBIT,EV_KEY); for(int k=1;k<248;k++) ioctl(fd,UI_SET_KEYBIT,k);
  struct uinput_user_dev ud={0}; snprintf(ud.name,sizeof ud.name,"Surface Duo Key"); ud.id.bustype=BUS_VIRTUAL; ud.id.vendor=0x045e; ud.id.product=0x0c03;
  write(fd,&ud,sizeof ud); if(ioctl(fd,UI_DEV_CREATE)){ perror("UI_DEV_CREATE"); return 1; }
  usleep(600000); /* let Mutter see the new device */
  int n=argc-1, codes[16]; for(int i=0;i<n&&i<16;i++){ codes[i]=code(argv[i+1]); if(codes[i]<0){ fprintf(stderr,"unbekannt: %s\n",argv[i+1]); return 1; } }
  for(int i=0;i<n;i++){ emit(fd,EV_KEY,codes[i],1); emit(fd,EV_SYN,SYN_REPORT,0); usleep(40000); }
  for(int i=n-1;i>=0;i--){ emit(fd,EV_KEY,codes[i],0); emit(fd,EV_SYN,SYN_REPORT,0); usleep(40000); }
  usleep(300000); ioctl(fd,UI_DEV_DESTROY); close(fd); return 0; }
