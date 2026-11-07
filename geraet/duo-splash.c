/* duo-splash: boot image on both DSI panels via KMS (dumb buffer, no GPU): dark background + centred image
 * (raw BGRA, width/height from the file header). Runs until SIGTERM arrives (systemctl stop), then releases DRM -> GDM takes over.
 * Usage: duo-splash /usr/share/duo/splash.bgra   (header: 2x uint32 w,h, then w*h*4 bytes BGRA) */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <stdint.h>
#include <sys/mman.h>
#include <xf86drm.h>
#include <xf86drmMode.h>

static volatile int stop = 0;
static void on_term(int s){ (void)s; stop = 1; }

struct out { uint32_t fb, handle; uint32_t *px; size_t size; drmModeCrtc *saved; uint32_t conn, crtc; drmModeModeInfo mode; };

static uint32_t used_crtcs = 0; /* bit mask of CRTC indices in use: each panel needs its own */
static int setup(int fd, drmModeRes *res, drmModeConnector *c, struct out *o, const uint32_t *img, uint32_t iw, uint32_t ih){
  if(!c->count_modes) return -1;
  o->mode = c->modes[0]; o->conn = c->connector_id; o->crtc = 0;
  /* collect possible CRTCs over all encoders of the connector, take the first one not yet used */
  uint32_t possible = 0;
  for(int k=0;k<c->count_encoders;k++){ drmModeEncoder *e = drmModeGetEncoder(fd, c->encoders[k]); if(e){ possible |= e->possible_crtcs; drmModeFreeEncoder(e); } }
  for(int i=0;i<res->count_crtcs && !o->crtc;i++) if((possible & (1u<<i)) && !(used_crtcs & (1u<<i))){ o->crtc = res->crtcs[i]; used_crtcs |= 1u<<i; }
  if(!o->crtc){ fprintf(stderr, "duo-splash: kein freier CRTC fuer Connector %u (moeglich 0x%x, belegt 0x%x)\n", c->connector_id, possible, used_crtcs); return -1; }
  struct drm_mode_create_dumb cd = { .width = o->mode.hdisplay, .height = o->mode.vdisplay, .bpp = 32 };
  if(drmIoctl(fd, DRM_IOCTL_MODE_CREATE_DUMB, &cd)) { perror("create_dumb"); return -1; }
  o->handle = cd.handle; o->size = cd.size;
  if(drmModeAddFB(fd, cd.width, cd.height, 24, 32, cd.pitch, cd.handle, &o->fb)) { perror("addfb"); return -1; }
  struct drm_mode_map_dumb md = { .handle = cd.handle };
  if(drmIoctl(fd, DRM_IOCTL_MODE_MAP_DUMB, &md)) { perror("map_dumb"); return -1; }
  o->px = mmap(0, cd.size, PROT_READ|PROT_WRITE, MAP_SHARED, fd, md.offset);
  if(o->px == MAP_FAILED){ perror("mmap"); return -1; }
  uint32_t W = cd.width, H = cd.height, P = cd.pitch/4;
  for(uint32_t y=0;y<H;y++) for(uint32_t x=0;x<W;x++) o->px[y*P+x] = 0xff101418; /* dunkles Blaugrau */
  if(img){ uint32_t ox = (W>iw)?(W-iw)/2:0, oy = (H>ih)?(H-ih)/2:0;
    for(uint32_t y=0;y<ih && oy+y<H;y++) for(uint32_t x=0;x<iw && ox+x<W;x++){
      uint32_t s = img[y*iw+x]; uint32_t a = s>>24; if(!a) continue;
      uint32_t d = o->px[(oy+y)*P+ox+x];
      uint32_t r = ((s>>16&255)*a + (d>>16&255)*(255-a))/255, g = ((s>>8&255)*a + (d>>8&255)*(255-a))/255, b = ((s&255)*a + (d&255)*(255-a))/255;
      o->px[(oy+y)*P+ox+x] = 0xff000000 | r<<16 | g<<8 | b; } }
  o->saved = drmModeGetCrtc(fd, o->crtc);
  if(drmModeSetCrtc(fd, o->crtc, o->fb, 0, 0, &o->conn, 1, &o->mode)) { perror("setcrtc"); return -1; }
  return 0;
}

int main(int argc, char **argv){
  const char *imgpath = argc>1 ? argv[1] : "/usr/share/duo/splash.bgra";
  uint32_t *img = NULL, iw = 0, ih = 0;
  FILE *f = fopen(imgpath, "rb");
  if(f){ uint32_t hdr[2]; if(fread(hdr,4,2,f)==2){ iw=hdr[0]; ih=hdr[1]; img = malloc((size_t)iw*ih*4); if(fread(img,4,(size_t)iw*ih,f)!=(size_t)iw*ih){ free(img); img=NULL; } } fclose(f); }
  if(!img) fprintf(stderr, "duo-splash: kein Bild (%s), nur Hintergrund\n", imgpath);
  int fd = open("/dev/dri/card0", O_RDWR|O_CLOEXEC); if(fd<0){ perror("/dev/dri/card0"); return 1; }
  drmSetMaster(fd);
  drmModeRes *res = drmModeGetResources(fd); if(!res){ perror("resources"); return 1; }
  struct out outs[4]; int n = 0;
  for(int i=0;i<res->count_connectors && n<4;i++){
    drmModeConnector *c = drmModeGetConnector(fd, res->connectors[i]);
    if(c && c->connection == DRM_MODE_CONNECTED && c->connector_type == DRM_MODE_CONNECTOR_DSI){
      memset(&outs[n],0,sizeof outs[n]);
      if(setup(fd, res, c, &outs[n], img, iw, ih)==0){ fprintf(stderr, "duo-splash: Panel %u (%ux%u) gemalt\n", c->connector_id, outs[n].mode.hdisplay, outs[n].mode.vdisplay); n++; }
    }
    if(c) drmModeFreeConnector(c);
  }
  signal(SIGTERM, on_term); signal(SIGINT, on_term);
  /* detach fbcon (getty/VT switch would otherwise overwrite our image) */
  { FILE *b; for(int i=0;i<3;i++){ char n[64], nm[128]=""; snprintf(n,sizeof n,"/sys/class/vtconsole/vtcon%d/name",i); FILE *fn=fopen(n,"r");
      if(fn){ if(!fgets(nm,sizeof nm,fn)) nm[0]=0; fclose(fn); } if(strstr(nm,"frame buffer")){ snprintf(n,sizeof n,"/sys/class/vtconsole/vtcon%d/bind",i); b=fopen(n,"w"); if(b){ fputs("0",b); fclose(b); fprintf(stderr,"duo-splash: fbcon abgekoppelt (vtcon%d)\n",i);} } } }
  /* switch on the backlight (before the compositor it is often off) */
  { const char *bl[2][2]={{"/sys/class/backlight/panel0-backlight/bl_power","/sys/class/backlight/panel0-backlight/brightness"},
                          {"/sys/class/backlight/panel1-backlight/bl_power","/sys/class/backlight/panel1-backlight/brightness"}};
    for(int i=0;i<2;i++){ FILE *b=fopen(bl[i][0],"w"); if(b){ fputs("0",b); fclose(b);} b=fopen(bl[i][1],"w"); if(b){ fputs("160",b); fclose(b);} } }
  /* only set the image again if the panel was actually switched off (every SetCrtc is a full modeset) */
  while(!stop){ usleep(500000); FILE *e=fopen("/sys/class/drm/card0-DSI-1/enabled","r"); char st[16]="";
    if(e){ if(!fgets(st,sizeof st,e)) st[0]=0; fclose(e); }
    if(strncmp(st,"enabled",7)!=0){ fprintf(stderr,"duo-splash: Panel war %s, setze neu\n", st);
      for(int i=0;i<n;i++) drmModeSetCrtc(fd, outs[i].crtc, outs[i].fb, 0, 0, &outs[i].conn, 1, &outs[i].mode); sleep(2); } }
  for(int i=0;i<n;i++){ munmap(outs[i].px, outs[i].size); drmModeRmFB(fd, outs[i].fb);
    struct drm_mode_destroy_dumb dd = { .handle = outs[i].handle }; drmIoctl(fd, DRM_IOCTL_MODE_DESTROY_DUMB, &dd); }
  drmDropMaster(fd); close(fd); fprintf(stderr, "duo-splash: Ende\n"); return 0;
}
