#!/usr/bin/env python3
"""
Generates data.db — a read-only SQLite database of mock application data
(users, accounts, transactions) plus a logs table spanning three mock
services, for the "Log Challenge" support-engineer exercise.

Deterministic: same seed -> same output, so the ticket text in
js/challenge.js and the walkthroughs in answers.html (which reference
specific usernames/merchants/dates) stay accurate.

Usage:
    python3 data/build_db.py [output_path]
"""
import json
import os
import random
import sqlite3
import sys
from datetime import datetime, timedelta

SEED = 20260814
random.seed(SEED)

OUT_PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(__file__), "..", "data.db"
)

# ---------------------------------------------------------------------------
# Time window: 10 days of history ending at a fixed "now" so the dataset is
# reproducible regardless of when the generator is run.
# ---------------------------------------------------------------------------
END_TS = datetime(2026, 8, 14, 7, 0, 0)
WINDOW_DAYS = 10
START_TS = END_TS - timedelta(days=WINDOW_DAYS)

SERVICES = ["auth-service", "payments-service", "notifications-service"]


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def rand_ts(start=START_TS, end=END_TS):
    delta = end - start
    seconds = random.uniform(0, delta.total_seconds())
    return start + timedelta(seconds=seconds)


def rand_hex(n):
    return "".join(random.choice("0123456789abcdef") for _ in range(n))


def trace_id():
    return rand_hex(32)


def request_id():
    return "req_" + rand_hex(16)


# ---------------------------------------------------------------------------
# Name pools
# ---------------------------------------------------------------------------
FIRST_NAMES = [
    "James", "Mary", "Robert", "Patricia", "John", "Jennifer", "Michael",
    "Linda", "David", "Elizabeth", "William", "Barbara", "Richard", "Susan",
    "Joseph", "Jessica", "Thomas", "Sarah", "Charles", "Karen", "Chris",
    "Nancy", "Daniel", "Lisa", "Matthew", "Betty", "Anthony", "Margaret",
    "Mark", "Sandra", "Grace", "Ashley", "Kevin", "Kimberly", "Brian",
    "Emily", "Steven", "Donna", "Edward", "Michelle", "Ronald", "Dorothy",
    "Timothy", "Carol", "Jason", "Amanda", "Jeff", "Melissa", "Ryan",
    "Deborah", "Jacob", "Stephanie", "Gary", "Rebecca", "Nicholas", "Laura",
    "Eric", "Sharon", "Jonathan", "Cynthia", "Diego", "Priya", "Wei",
    "Fatima", "Hiroshi", "Elena", "Omar", "Ingrid", "Kwame", "Yuki",
]
LAST_NAMES = [
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
    "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez",
    "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin",
    "Lee", "Perez", "Thompson", "White", "Harris", "Sanchez", "Clark",
    "Ramirez", "Lewis", "Robinson", "Walker", "Young", "Allen", "King",
    "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores", "Green",
    "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell",
    "Carter", "Roberts", "Kim", "Patel", "Okafor", "Kowalski", "Haddad",
    "Tanaka", "Petrov", "Larsen", "Osei", "Novak",
]
MERCHANTS = [
    "Green Leaf Cafe", "Acme Movers", "Northbound Coffee", "Urban Fitness Co",
    "Riverside Grocery", "Cascade Hardware", "Blue Sparrow Books",
    "Pinecrest Cinemas", "Harborview Pharmacy", "Aster Electronics",
    "Copper Kettle Diner", "Wayfinder Travel", "Maple & Oak Furnishings",
    "Summit Outfitters", "Lantern Street Bakery", "Quickstop Fuel",
    "Cedarline Veterinary", "Foothill Auto Repair", "Bright Path Tutoring",
    "Willow Creek Nursery",
]
TXN_TYPES_WEIGHTED = [
    ("purchase", 55), ("transfer", 15), ("deposit", 12),
    ("withdrawal", 10), ("refund", 5), ("fee", 3),
]


def weighted_choice(pairs):
    total = sum(w for _, w in pairs)
    r = random.uniform(0, total)
    upto = 0
    for val, w in pairs:
        upto += w
        if r <= upto:
            return val
    return pairs[-1][0]


def make_username(first, last, used):
    base = f"{first.lower()}.{last.lower()}"
    candidate = base
    n = 1
    while candidate in used:
        n += 1
        candidate = f"{base}{n}"
    used.add(candidate)
    return candidate


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE users (
    id              INTEGER PRIMARY KEY,
    username        TEXT UNIQUE NOT NULL,
    email           TEXT NOT NULL,
    full_name       TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active', -- active, locked, suspended, closed
    created_at      TEXT NOT NULL,
    last_login_at   TEXT,
    locked_at       TEXT,
    locked_reason   TEXT
);

CREATE TABLE accounts (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    account_number  TEXT UNIQUE NOT NULL,
    account_type    TEXT NOT NULL,   -- checking, savings, credit
    currency        TEXT NOT NULL,   -- USD, EUR, GBP
    balance_cents   INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active', -- active, frozen, closed
    created_at      TEXT NOT NULL
);

CREATE TABLE transactions (
    id                  INTEGER PRIMARY KEY,
    account_id          INTEGER NOT NULL REFERENCES accounts(id),
    related_account_id  INTEGER REFERENCES accounts(id),
    type                TEXT NOT NULL,   -- purchase, transfer, deposit, withdrawal, refund, fee
    amount_cents        INTEGER NOT NULL,
    currency            TEXT NOT NULL,
    status              TEXT NOT NULL,   -- completed, pending, failed, reversed
    merchant            TEXT,
    description         TEXT,
    idempotency_key     TEXT,
    failure_reason      TEXT,
    created_at          TEXT NOT NULL
);

CREATE TABLE logs (
    id              INTEGER PRIMARY KEY,
    ts              TEXT NOT NULL,
    service         TEXT NOT NULL,   -- auth-service, payments-service, notifications-service
    level           TEXT NOT NULL,   -- DEBUG, INFO, WARN, ERROR
    message         TEXT NOT NULL,
    request_id      TEXT,
    trace_id        TEXT,
    user_id         INTEGER,
    account_id      INTEGER,
    transaction_id  INTEGER,
    http_method     TEXT,
    http_path       TEXT,
    http_status     INTEGER,
    duration_ms     INTEGER,
    error_type      TEXT,
    stack_trace     TEXT,
    metadata        TEXT  -- JSON
);

CREATE INDEX idx_logs_ts ON logs(ts);
CREATE INDEX idx_logs_service ON logs(service);
CREATE INDEX idx_logs_level ON logs(level);
CREATE INDEX idx_accounts_user ON accounts(user_id);
CREATE INDEX idx_transactions_account ON transactions(account_id);
"""

# ---------------------------------------------------------------------------
# 1. Users
# ---------------------------------------------------------------------------
N_USERS = 60
users = []
used_usernames = set()
for i in range(1, N_USERS + 1):
    first = random.choice(FIRST_NAMES)
    last = random.choice(LAST_NAMES)
    username = make_username(first, last, used_usernames)
    created = rand_ts(START_TS - timedelta(days=400), START_TS - timedelta(days=1))
    users.append({
        "id": i,
        "username": username,
        "email": f"{username}@example.com",
        "full_name": f"{first} {last}",
        "status": "active",
        "created_at": iso(created),
        "last_login_at": None,
        "locked_at": None,
        "locked_reason": None,
    })

# ---------------------------------------------------------------------------
# 2. Accounts
# ---------------------------------------------------------------------------
accounts = []
acct_id = 1
user_to_accounts = {}
for u in users:
    n_acct = random.choices([1, 2], weights=[70, 30])[0]
    user_to_accounts[u["id"]] = []
    for _ in range(n_acct):
        currency = random.choices(["USD", "EUR", "GBP"], weights=[92, 5, 3])[0]
        acc_type = random.choices(["checking", "savings", "credit"], weights=[60, 30, 10])[0]
        balance = random.randint(1200, 850000)  # cents
        accounts.append({
            "id": acct_id,
            "user_id": u["id"],
            "account_number": f"AC-{100000 + acct_id}",
            "account_type": acc_type,
            "currency": currency,
            "balance_cents": balance,
            "status": "active",
            "created_at": u["created_at"],
        })
        user_to_accounts[u["id"]].append(acct_id)
        acct_id += 1

# ---------------------------------------------------------------------------
# 3. Baseline transactions
# ---------------------------------------------------------------------------
transactions = []
txn_id = 1
for a in accounts:
    n_txn = random.randint(4, 18)
    for _ in range(n_txn):
        ttype = weighted_choice(TXN_TYPES_WEIGHTED)
        amount = random.randint(500, 45000)
        status = random.choices(["completed", "pending", "failed"], weights=[92, 4, 4])[0]
        merchant = random.choice(MERCHANTS) if ttype in ("purchase", "refund") else None
        failure_reason = None
        if status == "failed":
            failure_reason = random.choice(["card_declined", "gateway_timeout", "insufficient_funds"])
        transactions.append({
            "id": txn_id,
            "account_id": a["id"],
            "related_account_id": None,
            "type": ttype,
            "amount_cents": amount,
            "currency": a["currency"],
            "status": status,
            "merchant": merchant,
            "description": f"{ttype.capitalize()}" + (f" at {merchant}" if merchant else ""),
            "idempotency_key": "idem_" + rand_hex(20),
            "failure_reason": failure_reason,
            "created_at": iso(rand_ts()),
        })
        txn_id += 1

# ---------------------------------------------------------------------------
# Baseline logs (noise) — request/health-check style traffic per service
# ---------------------------------------------------------------------------
logs = []
log_id_counter = [1]


def add_log(ts, service, level, message, **kw):
    entry = {
        "id": log_id_counter[0],
        "ts": iso(ts) if isinstance(ts, datetime) else ts,
        "service": service,
        "level": level,
        "message": message,
        "request_id": kw.get("request_id"),
        "trace_id": kw.get("trace_id"),
        "user_id": kw.get("user_id"),
        "account_id": kw.get("account_id"),
        "transaction_id": kw.get("transaction_id"),
        "http_method": kw.get("http_method"),
        "http_path": kw.get("http_path"),
        "http_status": kw.get("http_status"),
        "duration_ms": kw.get("duration_ms"),
        "error_type": kw.get("error_type"),
        "stack_trace": kw.get("stack_trace"),
        "metadata": json.dumps(kw["metadata"]) if kw.get("metadata") is not None else None,
    }
    logs.append(entry)
    log_id_counter[0] += 1


AUTH_PATHS = ["/v1/auth/login", "/v1/auth/logout", "/v1/auth/refresh", "/v1/auth/session"]
PAY_PATHS = ["/v1/charges", "/v1/accounts/{id}/balance", "/v1/transfers", "/v1/refunds"]
NOTIF_PATHS = ["/v1/notifications/email", "/v1/notifications/push", "/v1/notifications/receipt"]

cur_day = START_TS
day_index = 0
while cur_day < END_TS:
    day_start = cur_day
    day_end = min(cur_day + timedelta(days=1), END_TS)
    for service in SERVICES:
        n = random.randint(70, 130)
        for _ in range(n):
            ts = rand_ts(day_start, day_end)
            u = random.choice(users)
            accts = user_to_accounts.get(u["id"]) or []
            a = accounts[random.choice(accts) - 1] if accts else None

            if service == "auth-service":
                roll = random.random()
                if roll < 0.85:
                    add_log(ts, service, "INFO", "login succeeded",
                            request_id=request_id(), trace_id=trace_id(),
                            user_id=u["id"], http_method="POST",
                            http_path="/v1/auth/login", http_status=200,
                            duration_ms=random.randint(40, 220))
                elif roll < 0.95:
                    add_log(ts, service, "DEBUG", "session token refreshed",
                            request_id=request_id(), trace_id=trace_id(),
                            user_id=u["id"], http_method="POST",
                            http_path="/v1/auth/refresh", http_status=200,
                            duration_ms=random.randint(10, 60))
                else:
                    add_log(ts, service, "WARN", "invalid password attempt",
                            request_id=request_id(), trace_id=trace_id(),
                            user_id=u["id"], http_method="POST",
                            http_path="/v1/auth/login", http_status=401,
                            duration_ms=random.randint(30, 100))
            elif service == "payments-service":
                roll = random.random()
                if not a:
                    continue
                if roll < 0.55:
                    add_log(ts, service, "INFO", "balance check",
                            request_id=request_id(), trace_id=trace_id(),
                            user_id=u["id"], account_id=a["id"],
                            http_method="GET",
                            http_path=f"/v1/accounts/{a['id']}/balance",
                            http_status=200, duration_ms=random.randint(15, 90))
                elif roll < 0.9:
                    add_log(ts, service, "INFO", "charge settled",
                            request_id=request_id(), trace_id=trace_id(),
                            user_id=u["id"], account_id=a["id"],
                            http_method="POST", http_path="/v1/charges",
                            http_status=200, duration_ms=random.randint(80, 400))
                elif roll < 0.97:
                    add_log(ts, service, "WARN", "upstream gateway slow response",
                            request_id=request_id(), trace_id=trace_id(),
                            user_id=u["id"], account_id=a["id"],
                            http_method="POST", http_path="/v1/charges",
                            http_status=200, duration_ms=random.randint(1200, 3000))
                else:
                    add_log(ts, service, "ERROR", "database connection pool exhausted, retrying",
                            request_id=request_id(), trace_id=trace_id(),
                            error_type="PoolExhaustedError",
                            duration_ms=random.randint(500, 1500))
            else:  # notifications-service
                roll = random.random()
                if roll < 0.7:
                    add_log(ts, service, "INFO", "email queued",
                            request_id=request_id(), trace_id=trace_id(),
                            user_id=u["id"], http_method="POST",
                            http_path="/v1/notifications/email", http_status=202,
                            duration_ms=random.randint(5, 40))
                elif roll < 0.92:
                    add_log(ts, service, "INFO", "email sent",
                            request_id=request_id(), trace_id=trace_id(),
                            user_id=u["id"], duration_ms=random.randint(100, 600))
                else:
                    add_log(ts, service, "WARN", "email bounced: mailbox full",
                            request_id=request_id(), trace_id=trace_id(),
                            user_id=u["id"], duration_ms=random.randint(50, 200))
    cur_day += timedelta(days=1)
    day_index += 1

# ---------------------------------------------------------------------------
# Scenario A — Insufficient funds decline
# ---------------------------------------------------------------------------
userA = users[6]
acctA_id = user_to_accounts[userA["id"]][0]
acctA = accounts[acctA_id - 1]
acctA["balance_cents"] = 3421
tsA = END_TS - timedelta(days=7, hours=3, minutes=12)
amtA = 8450
merchantA = "Green Leaf Cafe"
txn_id += 1
transactions.append({
    "id": txn_id, "account_id": acctA["id"], "related_account_id": None,
    "type": "purchase", "amount_cents": amtA, "currency": acctA["currency"],
    "status": "failed", "merchant": merchantA,
    "description": f"Purchase at {merchantA}",
    "idempotency_key": "idem_" + rand_hex(20),
    "failure_reason": "insufficient_funds", "created_at": iso(tsA),
})
txnA_id = txn_id
reqA, trA = request_id(), trace_id()
add_log(tsA - timedelta(seconds=1), "payments-service", "INFO", "charge attempt received",
        request_id=reqA, trace_id=trA, user_id=userA["id"], account_id=acctA["id"],
        transaction_id=txnA_id, http_method="POST", http_path="/v1/charges",
        metadata={"amount_cents": amtA, "merchant": merchantA})
add_log(tsA, "payments-service", "ERROR", "charge declined: insufficient funds",
        request_id=reqA, trace_id=trA, user_id=userA["id"], account_id=acctA["id"],
        transaction_id=txnA_id, http_method="POST", http_path="/v1/charges",
        http_status=402, duration_ms=random.randint(60, 150),
        error_type="InsufficientFundsError",
        metadata={"amount_cents": amtA, "balance_cents": acctA["balance_cents"], "merchant": merchantA})
# ---------------------------------------------------------------------------
# Scenario B — Duplicate charge from a client retry on a slow gateway
# ---------------------------------------------------------------------------
userB = users[14]
acctB_id = user_to_accounts[userB["id"]][0]
acctB = accounts[acctB_id - 1]
tsB1 = END_TS - timedelta(days=4, hours=9, minutes=40)
tsB2 = tsB1 + timedelta(seconds=14)
amtB = 21999
merchantB = "Acme Movers"
sharedKeyB = "idem_" + rand_hex(20)

txn_id += 1
txnB1_id = txn_id
transactions.append({
    "id": txnB1_id, "account_id": acctB["id"], "related_account_id": None,
    "type": "purchase", "amount_cents": amtB, "currency": acctB["currency"],
    "status": "completed", "merchant": merchantB,
    "description": f"Purchase at {merchantB}",
    "idempotency_key": sharedKeyB, "failure_reason": None, "created_at": iso(tsB1),
})
txn_id += 1
txnB2_id = txn_id
transactions.append({
    "id": txnB2_id, "account_id": acctB["id"], "related_account_id": None,
    "type": "purchase", "amount_cents": amtB, "currency": acctB["currency"],
    "status": "completed", "merchant": merchantB,
    "description": f"Purchase at {merchantB}",
    "idempotency_key": sharedKeyB, "failure_reason": None, "created_at": iso(tsB2),
})

reqB1, trB1 = request_id(), trace_id()
add_log(tsB1 - timedelta(seconds=2), "payments-service", "INFO", "charge attempt received",
        request_id=reqB1, trace_id=trB1, user_id=userB["id"], account_id=acctB["id"],
        transaction_id=txnB1_id, http_method="POST", http_path="/v1/charges",
        metadata={"amount_cents": amtB, "merchant": merchantB, "idempotency_key": sharedKeyB})
add_log(tsB1 - timedelta(seconds=1, milliseconds=200), "payments-service", "WARN",
        "upstream gateway slow response", request_id=reqB1, trace_id=trB1,
        user_id=userB["id"], account_id=acctB["id"], transaction_id=txnB1_id,
        http_method="POST", http_path="/v1/charges", duration_ms=6400)
add_log(tsB1, "payments-service", "INFO", "charge created",
        request_id=reqB1, trace_id=trB1, user_id=userB["id"], account_id=acctB["id"],
        transaction_id=txnB1_id, http_method="POST", http_path="/v1/charges",
        http_status=200, duration_ms=6400,
        metadata={"amount_cents": amtB, "idempotency_key": sharedKeyB})

reqB2, trB2 = request_id(), trace_id()
add_log(tsB2 - timedelta(seconds=1), "payments-service", "INFO", "charge attempt received (client retry)",
        request_id=reqB2, trace_id=trB2, user_id=userB["id"], account_id=acctB["id"],
        transaction_id=txnB2_id, http_method="POST", http_path="/v1/charges",
        metadata={"amount_cents": amtB, "merchant": merchantB, "idempotency_key": sharedKeyB})
add_log(tsB2, "payments-service", "INFO", "charge created",
        request_id=reqB2, trace_id=trB2, user_id=userB["id"], account_id=acctB["id"],
        transaction_id=txnB2_id, http_method="POST", http_path="/v1/charges",
        http_status=200, duration_ms=random.randint(90, 200),
        metadata={"amount_cents": amtB, "idempotency_key": sharedKeyB,
                  "note": "idempotency key reused but treated as new charge"})
# ---------------------------------------------------------------------------
# Scenario C — Account lockout after repeated failed logins
# ---------------------------------------------------------------------------
userC = users[27]
tsC_start = END_TS - timedelta(days=2, hours=1, minutes=5)
attempts = []
t = tsC_start
for i in range(5):
    t = t + timedelta(seconds=random.randint(8, 25))
    attempts.append(t)
tsC_lock = attempts[-1] + timedelta(seconds=3)

for i, t in enumerate(attempts):
    add_log(t, "auth-service", "WARN", "invalid password attempt",
            request_id=request_id(), trace_id=trace_id(), user_id=userC["id"],
            http_method="POST", http_path="/v1/auth/login", http_status=401,
            duration_ms=random.randint(30, 90),
            metadata={"attempt_number": i + 1})
add_log(tsC_lock, "auth-service", "ERROR", "account locked after repeated failed logins",
        request_id=request_id(), trace_id=trace_id(), user_id=userC["id"],
        http_method="POST", http_path="/v1/auth/login", http_status=423,
        error_type="AccountLockedError",
        metadata={"failed_attempts": len(attempts), "window_seconds": 90})

userC["status"] = "locked"
userC["locked_at"] = iso(tsC_lock)
userC["locked_reason"] = "too_many_failed_logins"

# ---------------------------------------------------------------------------
# Scenario D — Unhandled exception rendering a receipt for a non-USD account
# ---------------------------------------------------------------------------
userD = None
acctD = None
for u in users:
    for aid in user_to_accounts[u["id"]]:
        acc = accounts[aid - 1]
        if acc["currency"] == "EUR":
            userD, acctD = u, acc
            break
    if userD:
        break
if not userD:
    userD = users[33]
    acctD = accounts[user_to_accounts[userD["id"]][0] - 1]
    acctD["currency"] = "EUR"

tsD = END_TS - timedelta(days=5, hours=14, minutes=22)
amtD = 6200
txn_id += 1
txnD_id = txn_id
transactions.append({
    "id": txnD_id, "account_id": acctD["id"], "related_account_id": None,
    "type": "purchase", "amount_cents": amtD, "currency": acctD["currency"],
    "status": "completed", "merchant": "Wayfinder Travel",
    "description": "Purchase at Wayfinder Travel",
    "idempotency_key": "idem_" + rand_hex(20), "failure_reason": None,
    "created_at": iso(tsD - timedelta(minutes=1)),
})

reqD, trD = request_id(), trace_id()
stack_trace_D = (
    "UnsupportedCurrencyError: legacy formatter does not recognize currency \"EUR\"\n"
    "    at renderAmount (receipt.go:88)\n"
    "    at Render (receipt.go:41)\n"
    "    at worker.process (worker.go:112)\n"
    "    at worker.(*Pool).run (pool.go:57)"
)
add_log(tsD - timedelta(seconds=1), "notifications-service", "INFO", "receipt render requested",
        request_id=reqD, trace_id=trD, user_id=userD["id"], account_id=acctD["id"],
        transaction_id=txnD_id, http_method="POST",
        http_path="/v1/notifications/receipt",
        metadata={"currency": acctD["currency"], "template": "receipt_v2"})
add_log(tsD, "notifications-service", "ERROR", "unhandled exception rendering receipt template",
        request_id=reqD, trace_id=trD, user_id=userD["id"], account_id=acctD["id"],
        transaction_id=txnD_id, http_method="POST",
        http_path="/v1/notifications/receipt", http_status=500,
        duration_ms=random.randint(20, 80), error_type="UnsupportedCurrencyError",
        stack_trace=stack_trace_D,
        metadata={"currency": acctD["currency"], "template": "receipt_v2"})
# ---------------------------------------------------------------------------
# Scenario E — Silent failure: notifications-service never processes the
# request (no log line at all for that trace_id in that service).
# ---------------------------------------------------------------------------
userE = users[41]
acctE_id = user_to_accounts[userE["id"]][0]
acctE = accounts[acctE_id - 1]
tsE = END_TS - timedelta(days=1, hours=6, minutes=18)
amtE = 15000
txn_id += 1
txnE_id = txn_id
transactions.append({
    "id": txnE_id, "account_id": acctE["id"], "related_account_id": None,
    "type": "purchase", "amount_cents": amtE, "currency": acctE["currency"],
    "status": "completed", "merchant": "Summit Outfitters",
    "description": "Purchase at Summit Outfitters",
    "idempotency_key": "idem_" + rand_hex(20), "failure_reason": None,
    "created_at": iso(tsE),
})
trE = trace_id()
add_log(tsE - timedelta(seconds=2), "auth-service", "INFO", "session token verified",
        request_id=request_id(), trace_id=trE, user_id=userE["id"],
        http_method="GET", http_path="/v1/auth/session", http_status=200,
        duration_ms=random.randint(10, 40))
add_log(tsE - timedelta(seconds=1), "payments-service", "INFO", "charge attempt received",
        request_id=request_id(), trace_id=trE, user_id=userE["id"], account_id=acctE["id"],
        transaction_id=txnE_id, http_method="POST", http_path="/v1/charges",
        metadata={"amount_cents": amtE, "merchant": "Summit Outfitters"})
add_log(tsE, "payments-service", "INFO", "charge created",
        request_id=request_id(), trace_id=trE, user_id=userE["id"], account_id=acctE["id"],
        transaction_id=txnE_id, http_method="POST", http_path="/v1/charges",
        http_status=200, duration_ms=random.randint(80, 200),
        metadata={"amount_cents": amtE})
add_log(tsE + timedelta(milliseconds=400), "payments-service", "INFO", "charge settled",
        request_id=request_id(), trace_id=trE, user_id=userE["id"], account_id=acctE["id"],
        transaction_id=txnE_id, http_method="POST", http_path="/v1/charges",
        http_status=200, duration_ms=random.randint(40, 90))
# Deliberately: no notifications-service log entries carry trace_id == trE.

# ---------------------------------------------------------------------------
# Scenario F (bonus) — Systemic incident: gateway error spike across many
# accounts in a single ~35 minute window, unrelated to any one customer.
# ---------------------------------------------------------------------------
tsF_start = END_TS - timedelta(days=6, hours=10, minutes=0)
tsF_end = tsF_start + timedelta(minutes=35)
incident_users = random.sample(users, 14)
for u in incident_users:
    accts = user_to_accounts.get(u["id"]) or []
    if not accts:
        continue
    a = accounts[random.choice(accts) - 1]
    t = rand_ts(tsF_start, tsF_end)
    add_log(t, "payments-service", "ERROR", "charge failed: payment gateway unreachable",
            request_id=request_id(), trace_id=trace_id(), user_id=u["id"],
            account_id=a["id"], http_method="POST", http_path="/v1/charges",
            http_status=502, duration_ms=random.randint(3000, 5000),
            error_type="GatewayUnavailableError",
            metadata={"gateway": "stripe-primary", "region": "us-east-1"})

# ---------------------------------------------------------------------------
# Write the database
# ---------------------------------------------------------------------------
if os.path.exists(OUT_PATH):
    os.remove(OUT_PATH)

conn = sqlite3.connect(OUT_PATH)
conn.executescript(SCHEMA)

conn.executemany(
    "INSERT INTO users (id, username, email, full_name, status, created_at, "
    "last_login_at, locked_at, locked_reason) VALUES "
    "(:id, :username, :email, :full_name, :status, :created_at, "
    ":last_login_at, :locked_at, :locked_reason)",
    users,
)
conn.executemany(
    "INSERT INTO accounts (id, user_id, account_number, account_type, currency, "
    "balance_cents, status, created_at) VALUES "
    "(:id, :user_id, :account_number, :account_type, :currency, "
    ":balance_cents, :status, :created_at)",
    accounts,
)
conn.executemany(
    "INSERT INTO transactions (id, account_id, related_account_id, type, "
    "amount_cents, currency, status, merchant, description, idempotency_key, "
    "failure_reason, created_at) VALUES "
    "(:id, :account_id, :related_account_id, :type, :amount_cents, :currency, "
    ":status, :merchant, :description, :idempotency_key, :failure_reason, :created_at)",
    transactions,
)

logs.sort(key=lambda r: r["ts"])
for i, row in enumerate(logs, start=1):
    row["id"] = i
conn.executemany(
    "INSERT INTO logs (id, ts, service, level, message, request_id, trace_id, "
    "user_id, account_id, transaction_id, http_method, http_path, http_status, "
    "duration_ms, error_type, stack_trace, metadata) VALUES "
    "(:id, :ts, :service, :level, :message, :request_id, :trace_id, :user_id, "
    ":account_id, :transaction_id, :http_method, :http_path, :http_status, "
    ":duration_ms, :error_type, :stack_trace, :metadata)",
    logs,
)

conn.commit()

counts = {}
for t in ("users", "accounts", "transactions", "logs"):
    counts[t] = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]

conn.execute("VACUUM")
conn.close()

print(f"Wrote {OUT_PATH}")
print("Row counts:", counts)
