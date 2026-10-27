CREATE TABLE provider_credit_budgets (
 provider text NOT NULL,
 budget_day date NOT NULL,
 credits integer NOT NULL CHECK (credits >= 0),
 blocked_until timestamptz,
 PRIMARY KEY (provider, budget_day)
);
