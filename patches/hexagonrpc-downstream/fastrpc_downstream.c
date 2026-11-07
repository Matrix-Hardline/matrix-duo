/* SPDX-License-Identifier: GPL-3.0-or-later
 * Translation of the mainline FastRPC ioctls to Qualcomm's downstream driver adsprpc (msm-4.14).
 * See fastrpc_downstream.h. Surface Duo / Fedora, 30.10.2026. */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/ioctl.h>

#include <libhexagonrpc/hexagonrpc.h>
#include "fastrpc_downstream.h"
#undef ioctl   /* use the real ioctl() here */

#ifndef REMOTE_SCALARS_INHANDLES
#define REMOTE_SCALARS_INHANDLES(sc) (((sc) >> 4) & 0x0f)
#define REMOTE_SCALARS_OUTHANDLES(sc) ((sc) & 0x0f)
#endif
#define DS_SCALARS_LENGTH(sc) (REMOTE_SCALARS_INBUFS(sc) + REMOTE_SCALARS_OUTBUFS(sc) + REMOTE_SCALARS_INHANDLES(sc) + REMOTE_SCALARS_OUTHANDLES(sc))

static int ds_select_domain(int fd, uint32_t domain)
{
	uint32_t info = domain;
	int ret = ioctl(fd, DS_FASTRPC_IOCTL_GETINFO, &info);
	if (ret)
		fprintf(stderr, "fastrpc-downstream: GETINFO(Domaene %u) fehlgeschlagen: %s\n", domain, strerror(errno));
	return ret;
}

static int ds_attach(int fd, uint32_t flags, uint32_t default_domain)
{
	struct ds_fastrpc_ioctl_init init;
	uint32_t domain = default_domain;
	const char *env = getenv("HEXAGONRPC_DOMAIN");
	int ret;

	if (env && *env)
		domain = (uint32_t) strtoul(env, NULL, 10);
	ret = ds_select_domain(fd, domain);
	if (ret)
		return ret;
	memset(&init, 0, sizeof(init));
	init.flags = flags;
	init.filefd = -1;
	init.memfd = -1;
	ret = ioctl(fd, DS_FASTRPC_IOCTL_INIT, &init);
	if (ret)
		fprintf(stderr, "fastrpc-downstream: INIT(flags %u, Domaene %u) fehlgeschlagen: %s\n", flags, domain, strerror(errno));
	else
		fprintf(stderr, "fastrpc-downstream: angehaengt (flags %u, Domaene %u)\n", flags, domain);
	return ret;
}

static int ds_invoke(int fd, struct fastrpc_invoke *inv)
{
	struct fastrpc_invoke_args *args = (struct fastrpc_invoke_args *)(uintptr_t) inv->args;
	unsigned n = DS_SCALARS_LENGTH(inv->sc);
	union ds_remote_arg *pra;
	int *fds = NULL;
	int use_fds = 0;
	int ret;
	unsigned i;

	pra = calloc(n ? n : 1, sizeof(*pra));
	if (!pra)
		return -ENOMEM;
	for (i = 0; i < n; i++) {
		pra[i].buf.pv = (void *)(uintptr_t) args[i].ptr;
		pra[i].buf.len = (size_t) args[i].length;
		if (args[i].fd >= 0)
			use_fds = 1;
	}
	if (use_fds) {
		struct ds_fastrpc_ioctl_invoke_fd invfd;
		fds = calloc(n ? n : 1, sizeof(int));
		if (!fds) { free(pra); return -ENOMEM; }
		for (i = 0; i < n; i++)
			fds[i] = args[i].fd;
		invfd.inv.handle = inv->handle;
		invfd.inv.sc = inv->sc;
		invfd.inv.pra = pra;
		invfd.fds = fds;
		ret = ioctl(fd, DS_FASTRPC_IOCTL_INVOKE_FD, &invfd);
	} else {
		struct ds_fastrpc_ioctl_invoke dsinv;
		dsinv.handle = inv->handle;
		dsinv.sc = inv->sc;
		dsinv.pra = pra;
		ret = ioctl(fd, DS_FASTRPC_IOCTL_INVOKE, &dsinv);
	}
	free(fds);
	free(pra);
	return ret;
}

int hrpc_compat_ioctl(int fd, unsigned long request, void *arg)
{
	if (request == FASTRPC_IOCTL_INVOKE)
		return ds_invoke(fd, (struct fastrpc_invoke *) arg);
	if (request == FASTRPC_IOCTL_INIT_ATTACH_SNS)
		return ds_attach(fd, DS_FASTRPC_INIT_ATTACH_SENSORS, DS_SDSP_DOMAIN_ID);
	if (request == FASTRPC_IOCTL_INIT_ATTACH)
		return ds_attach(fd, DS_FASTRPC_INIT_ATTACH, DS_ADSP_DOMAIN_ID);
	if (request == FASTRPC_IOCTL_MMAP) {
		struct fastrpc_req_mmap *m = arg;
		struct ds_fastrpc_ioctl_mmap dm = { .fd = m->fd, .flags = m->flags, .vaddrin = (uintptr_t) m->vaddrin,
						    .size = (size_t) m->size, .vaddrout = 0 };
		int ret = ioctl(fd, DS_FASTRPC_IOCTL_MMAP, &dm);
		if (!ret)
			m->vaddrout = dm.vaddrout;
		return ret;
	}
	if (request == FASTRPC_IOCTL_MUNMAP) {
		struct fastrpc_req_munmap *m = arg;
		struct ds_fastrpc_ioctl_munmap dm = { .vaddrout = (uintptr_t) m->vaddrout, .size = (size_t) m->size };
		return ioctl(fd, DS_FASTRPC_IOCTL_MUNMAP, &dm);
	}
	if (request == FASTRPC_IOCTL_ALLOC_DMA_BUFF || request == FASTRPC_IOCTL_FREE_DMA_BUFF ||
	    request == FASTRPC_IOCTL_INIT_CREATE) {
		fprintf(stderr, "fastrpc-downstream: DMA-Puffer/INIT_CREATE werden nicht unterstuetzt (nur ATTACH-Modi)\n");
		errno = ENOSYS;
		return -1;
	}
	return ioctl(fd, request, arg);
}
