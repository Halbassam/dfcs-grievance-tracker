-- AFSCME Council 31 — FCRC Grievance Tracker
-- Migration 002: Add admin/steward roles to user accounts.
-- Run this ONLY if you already ran 001_init.sql before roles existed.
-- Brand-new installs using the current 001_init.sql do NOT need this.
-- Safe to re-run.

alter table users add column if not exists role text not null default 'steward';
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('admin','steward'));
