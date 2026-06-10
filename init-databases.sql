-- One database per service, each owned by its own role. Credentials match the
-- defaults in each repo's docker-compose.yml / .env.example, so the services
-- connect without any configuration beyond DB_HOST.
CREATE USER identity WITH PASSWORD 'identity';
CREATE DATABASE identity OWNER identity;

CREATE USER ledger WITH PASSWORD 'ledger';
CREATE DATABASE ledger OWNER ledger;
