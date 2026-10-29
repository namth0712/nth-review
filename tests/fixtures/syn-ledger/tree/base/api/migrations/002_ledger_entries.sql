CREATE TABLE ledger_entries (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  account_id BIGINT NOT NULL,
  amount_cents BIGINT NOT NULL,
  reference VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ledger_entries_account FOREIGN KEY (account_id) REFERENCES accounts (id)
);
