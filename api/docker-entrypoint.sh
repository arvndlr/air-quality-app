#!/bin/sh
set -eu

db_host="$(node -e 'const u = new URL(process.env.DATABASE_URL); process.stdout.write(u.hostname)')"
db_port="$(node -e 'const u = new URL(process.env.DATABASE_URL); process.stdout.write(u.port || "5432")')"
db_name="$(node -e 'const u = new URL(process.env.DATABASE_URL); process.stdout.write(u.pathname.startsWith("/") ? u.pathname.slice(1) : u.pathname)')"
db_user="$(node -e 'const u = new URL(process.env.DATABASE_URL); process.stdout.write(decodeURIComponent(u.username))')"
db_password="$(node -e 'const u = new URL(process.env.DATABASE_URL); process.stdout.write(decodeURIComponent(u.password))')"

export PGPASSWORD="$db_password"

wait_tries=0
until pg_isready -h "$db_host" -p "$db_port" -U "$db_user" -d "$db_name" >/dev/null 2>&1; do
  wait_tries=$((wait_tries + 1))
  if [ "$wait_tries" -ge 30 ]; then
    echo "Database did not become ready after ${wait_tries} checks" >&2
    exit 1
  fi
  echo "Waiting for PostgreSQL to become ready... (${wait_tries}/30)"
  sleep 2
done

migrate_tries=0
until npx prisma migrate deploy; do
  migrate_tries=$((migrate_tries + 1))
  if [ "$migrate_tries" -ge 10 ]; then
    echo "Prisma migrate failed after ${migrate_tries} attempts" >&2
    exit 1
  fi
  echo "Retrying Prisma migrate... (${migrate_tries}/10)"
  sleep 2
done

exec npm start
