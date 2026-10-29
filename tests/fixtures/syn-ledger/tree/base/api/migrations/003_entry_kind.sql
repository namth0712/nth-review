ALTER TABLE ledger_entries ADD COLUMN kind VARCHAR(16) NULL;

UPDATE ledger_entries SET kind = 'deposit' WHERE kind IS NULL AND amount_cents > 0;
UPDATE ledger_entries SET kind = 'withdrawal' WHERE kind IS NULL AND amount_cents < 0;

ALTER TABLE ledger_entries MODIFY kind VARCHAR(16) NOT NULL;
ALTER TABLE ledger_entries ADD UNIQUE KEY ledger_entries_kind_reference (account_id, kind, reference);
