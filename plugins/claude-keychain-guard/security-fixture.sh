#!/bin/sh
# Dummy transport for native delegate tests; never invokes macOS security.
printf 'DUMMY-PRIVATE-OUTPUT\n'
printf 'DUMMY-PRIVATE-ERROR\n' >&2
exit "${DUMMY_EXIT:-0}"
