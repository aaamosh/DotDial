#define _POSIX_C_SOURCE 200809L
#if defined(__APPLE__)
#define _DARWIN_C_SOURCE 1
#endif

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <time.h>

enum { LOCK_FD = 3, MAX_TIMEOUT_MS = 30000, EXIT_USAGE = 64, EXIT_OPERATION = 71, EXIT_BUSY = 75 };

static int operational_error(const char *reason) {
  fprintf(stderr, "dotdial-lock: %s\n", reason);
  return EXIT_OPERATION;
}

static int monotonic_milliseconds(uint64_t *result) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
  *result = (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 3 || strcmp(argv[1], "--timeout-ms") != 0 || argv[2][0] == '\0') {
    fprintf(stderr, "Usage: dotdial-lock --timeout-ms INTEGER (inherited regular fd 3)\n");
    return EXIT_USAGE;
  }
  for (const char *digit = argv[2]; *digit != '\0'; digit++) {
    if (*digit < '0' || *digit > '9') return EXIT_USAGE;
  }
  errno = 0;
  char *end;
  unsigned long timeout_ms = strtoul(argv[2], &end, 10);
  if (errno != 0 || *end != '\0' || timeout_ms > MAX_TIMEOUT_MS) return EXIT_USAGE;

  struct stat descriptor;
  if (fstat(LOCK_FD, &descriptor) != 0 || !S_ISREG(descriptor.st_mode)) {
    return operational_error("invalid_lock_descriptor");
  }
  uint64_t started;
  if (monotonic_milliseconds(&started) != 0) return operational_error("clock_failed");
  const uint64_t deadline = started + timeout_ms;

  for (;;) {
    if (flock(LOCK_FD, LOCK_EX | LOCK_NB) == 0) {
      // Never unlock: the caller's duplicate of this open file description
      // retains the kernel lock after the helper exits, until its last close.
      return 0;
    }
    const int lock_error = errno;
    if (lock_error != EWOULDBLOCK && lock_error != EAGAIN && lock_error != EINTR) {
      return operational_error("flock_failed");
    }
    uint64_t now;
    if (monotonic_milliseconds(&now) != 0) return operational_error("clock_failed");
    if (now >= deadline) {
      return lock_error == EINTR ? operational_error("flock_interrupted") : EXIT_BUSY;
    }
    const uint64_t remaining = deadline - now;
    const struct timespec pause = { .tv_sec = 0, .tv_nsec = (long)(remaining < 10 ? remaining : 10) * 1000000 };
    if (nanosleep(&pause, NULL) != 0 && errno != EINTR) return operational_error("wait_failed");
  }
}
