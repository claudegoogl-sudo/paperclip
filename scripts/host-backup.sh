#!/bin/bash
set -e

# Deployed copy of this script lives at ~/backups/backup.sh, invoked nightly
# by the operator's crontab. The two must be kept in sync by hand: after
# editing this file, copy it over the deployed one and confirm the copy is
# byte-identical before the next cron run:
#   cp scripts/host-backup.sh ~/backups/backup.sh
#   diff scripts/host-backup.sh ~/backups/backup.sh   # expect no output

BACKUP_DIR="$HOME/backups"
DATE=$(date +%Y%m%d-%H%M)
ARCHIVE="$BACKUP_DIR/paperclip-$DATE.tar.gz"

# Prune BEFORE tarring so the new backup has disk room.
# Retention: keep last 3 backups total. Drop everything past the newest 2;
# the archive created below becomes the 3rd. The glob covers both the
# regular rotation (paperclip-*) and one-off manual snapshots
# (pre-fork707*) -- previously pre-fork707* sat outside the glob entirely
# and never rotated out.
ls -1t "$BACKUP_DIR"/paperclip-*.tar.gz "$BACKUP_DIR"/pre-fork707*.tar.gz 2>/dev/null | tail -n +3 | xargs -r rm -f

tar -czf "$ARCHIVE" \
  --exclude='.paperclip/instances/default/data/backups' \
  --exclude='.paperclip/instances/default/data/run-logs' \
  --exclude='.paperclip/instances/default/logs' \
  --exclude='.paperclip/instances/default/projects' \
  --exclude='.paperclip/instances/default/workspaces' \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='dist' \
  --exclude='build' \
  --exclude='.expo' \
  --exclude='.cache' \
  --exclude='*.log' \
  --exclude='test-builds' \
  --exclude='*/android/build' \
  --exclude='*/android/.gradle' \
  --exclude='*/android/app/build' \
  --exclude='android-sdk' \
  --exclude='.git' \
  -C "$HOME" .paperclip

echo "Backup created: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
