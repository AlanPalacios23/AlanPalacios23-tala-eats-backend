-- G2 private Python V9 merchant inventory only.
CREATE TABLE waste_records (
 id SERIAL PRIMARY KEY,
 restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
 ingredient_id INTEGER REFERENCES ingredient_stocks(id),
 quantity NUMERIC(12,3) NOT NULL CHECK (quantity>0),
 reason VARCHAR(180) NOT NULL,
 estimated_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX waste_records_restaurant_id_idx ON waste_records(restaurant_id);
CREATE INDEX waste_records_ingredient_id_idx ON waste_records(ingredient_id);
