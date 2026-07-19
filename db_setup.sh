docker compose up -d
echo "connect at postgres://postgres:postgres@localhost:5433/dev_db"
trap "docker compose down" exit
while true; do sleep 1; done
