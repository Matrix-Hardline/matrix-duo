/* SPDX-License-Identifier: GPL-3.0-or-later
 * FastRPC compatibility layer for Qualcomm's downstream driver «adsprpc» (msm-4.14, Surface Duo 1).
 * Provides the mainline structures/ioctl names from <misc/fastrpc.h> and translates them at call time
 * (hrpc_compat_ioctl) to the downstream ABI: /dev/adsprpc-smd, domain via FASTRPC_IOCTL_GETINFO,
 * attaching via FASTRPC_IOCTL_INIT{flags}, arguments as remote_arg_t {pv,len}.
 * Surface Duo / Fedora, 30.10.2026. */
#ifndef FASTRPC_DOWNSTREAM_H
#define FASTRPC_DOWNSTREAM_H

#include <stdint.h>
#include <linux/types.h>
#include <sys/ioctl.h>

/* --- Mainline view (as in <misc/fastrpc.h>), used by libhexagonrpc/hexagonrpcd --- */
struct fastrpc_invoke_args {
	__u64 ptr;
	__u64 length;
	__s32 fd;
	__u32 attr;
};

struct fastrpc_invoke {
	__u32 handle;
	__u32 sc;
	__u64 args;
};

struct fastrpc_alloc_dma_buf {
	__s32 fd;
	__u32 flags;
	__u64 size;
};

struct fastrpc_init_create {
	__u32 filelen;
	__s32 filefd;
	__u32 attrs;
	__u32 siglen;
	__u64 file;
};

struct fastrpc_req_mmap {
	__s32 fd;
	__u32 flags;
	__u64 vaddrin;
	__u64 size;
	__u64 vaddrout;
};

struct fastrpc_req_munmap {
	__u64 vaddrout;
	__u64 size;
};

/* IDs of the mainline ioctls (only for telling them apart in hrpc_compat_ioctl) */
#define FASTRPC_IOCTL_ALLOC_DMA_BUFF	_IOWR('R', 1, struct fastrpc_alloc_dma_buf)
#define FASTRPC_IOCTL_FREE_DMA_BUFF	_IOWR('R', 2, __u32)
#define FASTRPC_IOCTL_INVOKE		_IOWR('R', 3, struct fastrpc_invoke)
#define FASTRPC_IOCTL_INIT_ATTACH	_IO('R', 4)
#define FASTRPC_IOCTL_INIT_CREATE	_IOWR('R', 5, struct fastrpc_init_create)
#define FASTRPC_IOCTL_MMAP		_IOWR('R', 6, struct fastrpc_req_mmap)
#define FASTRPC_IOCTL_MUNMAP		_IOWR('R', 7, struct fastrpc_req_munmap)
#define FASTRPC_IOCTL_INIT_ATTACH_SNS	_IO('R', 8)

/* --- Downstream-ABI (drivers/char/adsprpc_shared.h, msm-4.14) --- */
struct ds_remote_buf { void *pv; size_t len; };
struct ds_remote_dma_handle { int fd; uint32_t offset; };
union ds_remote_arg { struct ds_remote_buf buf; struct ds_remote_dma_handle dma; uint32_t h; };

struct ds_fastrpc_ioctl_invoke { uint32_t handle; uint32_t sc; union ds_remote_arg *pra; };
struct ds_fastrpc_ioctl_invoke_fd { struct ds_fastrpc_ioctl_invoke inv; int *fds; };
struct ds_fastrpc_ioctl_init {
	uint32_t flags; uintptr_t file; uint32_t filelen; int32_t filefd;
	uintptr_t mem; uint32_t memlen; int32_t memfd;
};
struct ds_fastrpc_ioctl_mmap { int fd; uint32_t flags; uintptr_t vaddrin; size_t size; uintptr_t vaddrout; };
struct ds_fastrpc_ioctl_munmap { uintptr_t vaddrout; size_t size; };

#define DS_FASTRPC_IOCTL_INVOKE		_IOWR('R', 1, struct ds_fastrpc_ioctl_invoke)
#define DS_FASTRPC_IOCTL_MMAP		_IOWR('R', 2, struct ds_fastrpc_ioctl_mmap)
#define DS_FASTRPC_IOCTL_MUNMAP		_IOWR('R', 3, struct ds_fastrpc_ioctl_munmap)
#define DS_FASTRPC_IOCTL_INVOKE_FD	_IOWR('R', 4, struct ds_fastrpc_ioctl_invoke_fd)
#define DS_FASTRPC_IOCTL_INIT		_IOWR('R', 6, struct ds_fastrpc_ioctl_init)
#define DS_FASTRPC_IOCTL_GETINFO	_IOWR('R', 8, uint32_t)

#define DS_FASTRPC_INIT_ATTACH		0
#define DS_FASTRPC_INIT_ATTACH_SENSORS	3
#define DS_ADSP_DOMAIN_ID		0
#define DS_SDSP_DOMAIN_ID		2

/* Domain for INIT_ATTACH (default ADSP); INIT_ATTACH_SNS always picks SDSP. Environment variable HEXAGONRPC_DOMAIN overrides. */
int hrpc_compat_ioctl(int fd, unsigned long request, void *arg);

/* All ioctl() calls of the including files go through the translation. */
#define ioctl(fd, request, arg) hrpc_compat_ioctl((fd), (unsigned long)(request), (void *)(uintptr_t)(arg))

#endif
