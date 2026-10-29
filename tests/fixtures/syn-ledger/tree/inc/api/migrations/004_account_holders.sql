CREATE TABLE account_holders (
  account_id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  PRIMARY KEY (account_id, customer_id),
  CONSTRAINT account_holders_account FOREIGN KEY (account_id) REFERENCES accounts (id)
);
