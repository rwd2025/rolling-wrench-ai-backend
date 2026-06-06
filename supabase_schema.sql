-- Rolling Wrench AI Supabase Tables
-- Run this in Supabase SQL Editor.

create extension if not exists "uuid-ossp";

create table if not exists customers (
  id uuid primary key default uuid_generate_v4(),
  name text,
  phone text,
  email text,
  address text,
  notes text,
  created_at timestamptz default now()
);

create table if not exists trucks (
  id uuid primary key default uuid_generate_v4(),
  customer_id uuid references customers(id) on delete set null,
  unit text,
  vin text,
  engine text,
  transmission text,
  mileage text,
  cpl text,
  notes text,
  created_at timestamptz default now()
);

create table if not exists quotes (
  id uuid primary key default uuid_generate_v4(),
  customer text,
  truck text,
  vin text,
  work text,
  desc text,
  parts text,
  hours numeric,
  rate numeric,
  service numeric,
  supplies numeric,
  total numeric,
  status text default 'Draft',
  signature jsonb,
  created_at timestamptz default now()
);

create table if not exists invoices (
  id uuid primary key default uuid_generate_v4(),
  customer text,
  truck text,
  vin text,
  work text,
  parts text,
  total numeric,
  status text default 'Draft',
  payment_status text default 'Unpaid',
  payment_url text,
  signature jsonb,
  created_at timestamptz default now()
);

create table if not exists work_orders (
  id uuid primary key default uuid_generate_v4(),
  customer text,
  truck text,
  complaint text,
  cause text,
  correction text,
  status text default 'Open',
  created_at timestamptz default now()
);

create table if not exists repair_memory (
  id uuid primary key default uuid_generate_v4(),
  title text,
  problem text,
  cause text,
  correction text,
  keywords text,
  truck jsonb,
  created_at timestamptz default now()
);

create table if not exists schedule (
  id uuid primary key default uuid_generate_v4(),
  date text,
  time text,
  customer text,
  job text,
  location text,
  tech text,
  status text default 'Scheduled',
  created_at timestamptz default now()
);

create table if not exists signatures (
  id uuid primary key default uuid_generate_v4(),
  type text,
  document_id text,
  signer_name text,
  data_url text,
  created_at timestamptz default now()
);

create table if not exists ai_conversations (
  id uuid primary key default uuid_generate_v4(),
  title text,
  messages jsonb,
  context jsonb,
  created_at timestamptz default now()
);
