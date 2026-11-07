/* duo-blmirror (30.10.2026): the Surface Duo 1 has two backlights (panel0/panel1); GNOME only controls the main monitor's.
 * Mirrors brightness and bl_power from panel0 to panel1 (polled every 100 ms, written only on change). */
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static const char *SRC_B="/sys/class/backlight/panel0-backlight/brightness";
static const char *DST_B="/sys/class/backlight/panel1-backlight/brightness";
static const char *SRC_P="/sys/class/backlight/panel0-backlight/bl_power";
static const char *DST_P="/sys/class/backlight/panel1-backlight/bl_power";

static int rd(const char *p){ FILE*f=fopen(p,"r"); int v=-1; if(f){ if(fscanf(f,"%d",&v)!=1) v=-1; fclose(f);} return v; }
static void wr(const char *p,int v){ FILE*f=fopen(p,"w"); if(f){ fprintf(f,"%d",v); fclose(f);} }

int main(void){
  int lb=-1, lp=-1;
  fprintf(stderr,"duo-blmirror: panel0 -> panel1\n");
  for(;;){
    int b=rd(SRC_B), p=rd(SRC_P);
    if(b>=0 && b!=lb){ wr(DST_B,b); lb=b; }
    if(p>=0 && p!=lp){ wr(DST_P,p); lp=p; }
    usleep(100000);
  }
  return 0;
}
