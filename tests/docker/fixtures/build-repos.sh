#!/bin/sh
# Builds the bare git repositories of the fixtures server (docs/testing.md §7.9) from the task in
# $1 into $2, with fixed authors and dates so every build yields the same commits:
#
#   single.git    one task at the root (git-single)
#   multi.git     two tasks in alpha/ and beta/ (candidate selection) plus a README
#   private.git   one task at the root (git-private); the server requires Basic auth for it
#   diverge.git   main = one task (git-diverge); branch "advanced" adds a commit on top of main (a
#                 fast-forward); branch "rewritten" is an unrelated history (a divergence). Tests copy
#                 it through POST /control/repos and move the copy's main to one of the branches.
set -eu

task_dir="$1"
out_dir="$2"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export GIT_AUTHOR_NAME="scantor tests" GIT_AUTHOR_EMAIL="tests@scantor.test"
export GIT_COMMITTER_NAME="scantor tests" GIT_COMMITTER_EMAIL="tests@scantor.test"
export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"

# add_task <dir> <name> [description]: copies the task into <dir> with the manifest name (and description).
add_task() {
  mkdir -p "$1"
  cp -R "$task_dir/." "$1/"
  sed -i "s/^name: .*/name: $2/" "$1/scantor.yaml"
  if [ -n "${3:-}" ]; then sed -i "s/^description: .*/description: $3/" "$1/scantor.yaml"; fi
}

# new_repo <name>: an empty working repository at $work/<name> on branch main.
new_repo() {
  git init -q -b main "$work/$1"
}

commit() { # <name> <message>
  git -C "$work/$1" add -A
  git -C "$work/$1" commit -q -m "$2"
}

publish() { # <name>
  git clone -q --mirror "$work/$1" "$out_dir/$1.git"
}

mkdir -p "$out_dir"

new_repo single
add_task "$work/single" git-single
commit single "add git-single"
publish single

new_repo multi
add_task "$work/multi/alpha" git-multi-alpha
add_task "$work/multi/beta" git-multi-beta
printf '# Two scantor tasks\n\nalpha/ and beta/ each hold one task.\n' > "$work/multi/README.md"
commit multi "add two tasks"
publish multi

new_repo private
add_task "$work/private" git-private
commit private "add git-private"
publish private

new_repo diverge
add_task "$work/diverge" git-diverge "The first commit of the divergence repository."
commit diverge "add git-diverge"
git -C "$work/diverge" checkout -q -b advanced
add_task "$work/diverge" git-diverge "The fast-forward commit of the divergence repository."
commit diverge "describe the fast-forward"
git -C "$work/diverge" checkout -q --orphan rewritten
git -C "$work/diverge" rm -q -rf .
add_task "$work/diverge" git-diverge "A rewritten history of the divergence repository."
commit diverge "rewrite the history"
git -C "$work/diverge" checkout -q main
publish diverge

# The mirrors keep origin remote settings of the working copies; drop them.
for repo in "$out_dir"/*.git; do
  git -C "$repo" config --unset remote.origin.url || true
  git -C "$repo" config --unset remote.origin.fetch || true
  git -C "$repo" config --unset remote.origin.mirror || true
done
