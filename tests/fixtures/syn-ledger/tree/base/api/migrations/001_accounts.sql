CREATE TABLE accounts (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  customer_id BIGINT NOT NULL,
  status ENUM('active', 'frozen') NOT NULL DEFAULT 'active',
  balance_cents BIGINT NOT NULL DEFAULT 0,
  KEY accounts_customer (customer_id)
);
