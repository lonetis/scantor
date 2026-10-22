#!/usr/bin/env bash
# `playwright test "$@"` in /work/tests with the environment the entrypoint wrote to
# /etc/profile.d/scantor-test.sh (docs/testing.md §7.4). Used by the entrypoint and by `just test-exec`;
# hands the reports to the host user afterwards and exits with Playwright's exit code.
set -uo pipefail

profile=/etc/profile.d/scantor-test.sh
if [ ! -r "$profile" ]; then
  echo "scantor-test-playwright: $profile is missing; the test stack is not up yet" >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$profile"

cd /work/tests || exit 1
npx --no-install playwright test "$@"
status=$?

if [ -n "${SCANTOR_TEST_HOST_UID:-}" ] && [ -n "${SCANTOR_TEST_HOST_GID:-}" ]; then
  for path in playwright-report test-results .auth; do
    if [ -e "$path" ]; then
      chown -R "$SCANTOR_TEST_HOST_UID:$SCANTOR_TEST_HOST_GID" "$path" || echo "could not chown $path" >&2
    fi
  done
fi
exit "$status"
