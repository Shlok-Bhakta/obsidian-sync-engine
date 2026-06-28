mkdir -p db_data
export PGDATA="db_data"
if [ ! -f db_data/PG_VERSION ]; then
  initdb --no-locale
fi
# postgres -k "db_data"
pg_ctl -D ./db_data -o "-c listen_addresses='127.0.0.1' -c port=5432 -c unix_socket_directories='/tmp'" -l logfile start
createdb -h 127.0.0.1 -p 5432 obsidian_sync 2>/dev/null || true
echo "connect at postgres://${USER}@127.0.0.1:5432/obsidian_sync"
trap "pg_ctl -D ./db_data stop && rm -rf ./db_data" exit
echo "Running... Press Ctrl+C to trigger cleanup and exit."
while true; do sleep 1; done
