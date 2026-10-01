-- Runs once on first container start (empty volume).
-- spendboard      : platform metadata (users, assets, versions, change requests)
-- demo_warehouse  : sample analytics data, registered as a global Postgres data source
CREATE DATABASE spendboard;
CREATE DATABASE spendboard_test;
CREATE DATABASE demo_warehouse;

-- Connectors run user SQL with a read-only role, never the owner role
CREATE ROLE warehouse_reader LOGIN PASSWORD 'reader';
ALTER ROLE warehouse_reader SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE demo_warehouse TO warehouse_reader;
