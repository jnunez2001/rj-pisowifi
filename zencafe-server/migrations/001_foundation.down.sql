-- Migration 001: Foundation (DOWN)
-- Reverses 001_foundation.up.sql. Drop order is the reverse of creation order
-- to respect foreign key dependencies.

DROP INDEX IF EXISTS idx_transactions_cafe_created;
DROP INDEX IF EXISTS idx_sessions_pc_ended;

DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS games;
DROP TABLE IF EXISTS wallets;
DROP TABLE IF EXISTS staff;

ALTER TABLE cafes DROP CONSTRAINT IF EXISTS fk_vip_seat_pc;

DROP TABLE IF EXISTS pcs;
DROP TABLE IF EXISTS cafes;
DROP TABLE IF EXISTS users;
