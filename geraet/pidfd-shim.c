/* pidfd-shim (05.11.2026): the Surface Duo kernel (msm-4.14) has pidfd_open() and, since our patch,
 * waitid(P_PIDFD) - so Qt 6 believes clone(CLONE_PIDFD) works, but the 4.14 clone() rejects the flag
 * (EINVAL: "Resource error (fork failure)" in Prism). This preload strips CLONE_PIDFD, clones the old way
 * and hands the caller a pidfd from pidfd_open() - same result for the parent. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <sched.h>
#include <stdarg.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>
#ifndef CLONE_PIDFD
#define CLONE_PIDFD 0x00001000
#endif
#ifndef SYS_pidfd_open
#define SYS_pidfd_open 434
#endif
typedef int (*clone_fn)(int (*)(void *), void *, int, void *, ...);

int clone(int (*fn)(void *), void *stack, int flags, void *arg, ...)
{
    va_list ap;
    va_start(ap, arg);
    pid_t *ptid = va_arg(ap, pid_t *);
    void *tls = va_arg(ap, void *);
    pid_t *ctid = va_arg(ap, pid_t *);
    va_end(ap);
    static clone_fn real;
    if (!real)
        real = (clone_fn)dlsym(RTLD_NEXT, "clone");
    if (!(flags & CLONE_PIDFD))
        return real(fn, stack, flags, arg, ptid, tls, ctid);
    int pid = real(fn, stack, flags & ~CLONE_PIDFD, arg, ptid, tls, ctid);
    if (pid > 0 && ptid)
        *ptid = (pid_t)syscall(SYS_pidfd_open, pid, 0);
    return pid;
}
