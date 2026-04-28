mkdir -p db_data
export PGDATA="db_data"
initdb --no-locale
# postgres -k "db_data"
pg_ctl -D ./db_data -o "-c unix_socket_directories='/tmp'" -l logfile start
echo "connect at postgresql://postgres?host=db_data"
trap "pg_ctl -D ./db_data stop" exit
echo "Running... Press Ctrl+C to trigger cleanup and exit."
while true; do sleep 1; done
