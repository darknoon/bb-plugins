#!/bin/sh
# Dummy transport for native delegate tests; never invokes macOS security.
if [ "${DUMMY_SLEEP:-0}" != 0 ]; then sleep "$DUMMY_SLEEP"; fi
printf 'DUMMY-PRIVATE-OUTPUT\n'
printf 'DUMMY-PRIVATE-ERROR\n' >&2
exit "${DUMMY_EXIT:-0}"
