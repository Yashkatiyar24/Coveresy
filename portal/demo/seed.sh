#!/usr/bin/env bash
# Builds a realistic demo dataset through the portal's own API, so documents are
# genuine R2 uploads, payouts come from real rule evaluation, and the audit log
# reflects work that actually happened.
#
#   BASE=http://127.0.0.1:8787 ./demo/seed.sh
#
# WIPES the target database's application data. Never run against production.
set -u
BASE="${BASE:-http://127.0.0.1:8787}"
TOKEN="${SETUP_TOKEN:-$(grep COVERESY_SETUP_TOKEN .dev.vars 2>/dev/null | cut -d'"' -f2)}"
ADMIN_EMAIL="${ADMIN_EMAIL:-anwar@coveresy.com}"
ADMIN_PASS="${ADMIN_PASS:-CoveresyDemo2026!}"
J=$(mktemp); TMP=$(mktemp -d)
post(){ curl -s -b "$J" -c "$J" -H "Origin: $BASE" -o /dev/null -w '%{http_code}' -X POST "$@"; }
say(){ printf '  %s\n' "$1"; }

doc(){ python3 demo/make-doc.py "$1" "$2" "$3" "$TMP/$4.pdf"; }

echo "Seeding $BASE"

# --- admin -------------------------------------------------------------------
post "$BASE/auth/setup" -d "token=$TOKEN&name=Anwar&email=$ADMIN_EMAIL&password=$ADMIN_PASS" >/dev/null
CODE=$(post "$BASE/auth/login" -d "email=$ADMIN_EMAIL&password=$ADMIN_PASS")
[ "$CODE" = "303" ] || { echo "login failed ($CODE) — is the server running, and is the setup token right?"; exit 1; }
say "signed in as $ADMIN_EMAIL"

id_of(){ curl -s -b "$J" "$BASE/applications/new" | grep -o "$1_[a-f0-9]*[^>]*>$2<" | grep -o "$1_[a-f0-9]*" | head -1; }

# --- master data -------------------------------------------------------------
while IFS='|' read -r name code; do
  [ -z "$name" ] && continue
  post "$BASE/masters/insurers" -d "name=$name&code=$code" >/dev/null
done <<'EOF'
Star Health and Allied Insurance|STAR
HDFC ERGO General Insurance|HDFCERGO
ICICI Lombard General Insurance|ICICIL
Niva Bupa Health Insurance|NIVA
HDFC Life Insurance|HDFCLIFE
Max Life Insurance|MAXLIFE
ICICI Prudential Life Insurance|IPRU
EOF
say "7 insurers"

for b in "Coverfox Insurance Broking|CFX" "Arham Secure Insurance Broking|ARHAM" "Good Insurance Brokers|GOOD"; do
  post "$BASE/masters/brokers" -d "name=${b%|*}&code=${b#*|}" >/dev/null
done
say "3 brokers"

while IFS='|' read -r name code; do
  [ -z "$name" ] && continue
  post "$BASE/masters/partners" -d "name=$name&code=$code" >/dev/null
done <<'EOF'
Sandeep Kulkarni|POS-1041
Meera Associates|POS-1088
Rajat Financial Services|POS-1123
Nisha Advisory|POS-1190
Vikram Insurance Point|POS-1215
EOF
say "5 POS partners"

for e in "Priya Sharma|EMP-01" "Arjun Nair|EMP-02" "Fatima Khan|EMP-03" "Rohit Verma|EMP-04"; do
  post "$BASE/masters/employees" -d "name=${e%|*}&code=${e#*|}" >/dev/null
done
say "4 employees"

post "$BASE/users" -d "name=Priya Sharma&email=priya@coveresy.com&role=operator&password=OperatorDemo2026" >/dev/null
post "$BASE/users" -d "name=Arjun Nair&email=arjun@coveresy.com&role=operator&password=OperatorDemo2026" >/dev/null
post "$BASE/users" -d "name=Deepak Rao&email=deepak@coveresy.com&role=viewer&password=ViewerDemo2026!" >/dev/null
say "2 operators + 1 viewer"

STAR=$(id_of ins "Star Health and Allied Insurance")
HDFCE=$(id_of ins "HDFC ERGO General Insurance")
ICICIL=$(id_of ins "ICICI Lombard General Insurance")
NIVA=$(id_of ins "Niva Bupa Health Insurance")
HDFCL=$(id_of ins "HDFC Life Insurance")
MAXL=$(id_of ins "Max Life Insurance")
IPRU=$(id_of ins "ICICI Prudential Life Insurance")

for p in "$STAR|health|Family Health Optima" "$STAR|health|Star Comprehensive" \
         "$HDFCE|health|Optima Secure" "$ICICIL|health|Health AdvantEdge" \
         "$NIVA|health|ReAssure 2.0" "$HDFCL|life|Click 2 Protect Super" \
         "$MAXL|life|Smart Secure Plus" "$IPRU|life|iProtect Smart"; do
  IFS='|' read -r ins cat nm <<<"$p"
  post "$BASE/masters/products" -d "insurer_id=$ins&category=$cat&name=$nm" >/dev/null
done
say "8 products"

# --- payout rules ------------------------------------------------------------
post "$BASE/masters/payout-rules" -d "payout_pct=10&tds_pct=5&effective_from=2026-01-01" >/dev/null
post "$BASE/masters/payout-rules" -d "insurer_id=$STAR&payout_pct=15&tds_pct=5&effective_from=2026-01-01" >/dev/null
post "$BASE/masters/payout-rules" -d "insurer_id=$HDFCL&payout_pct=22.5&tds_pct=5&effective_from=2026-01-01" >/dev/null
post "$BASE/masters/payout-rules" -d "insurer_id=$MAXL&payout_pct=20&tds_pct=5&effective_from=2026-01-01" >/dev/null
say "4 payout rules (generic 10%, Star 15%, HDFC Life 22.5%, Max Life 20%)"

# --- applications ------------------------------------------------------------
PARTNERS=$(curl -s -b "$J" "$BASE/applications/new" | grep -o 'par_[a-f0-9]*' | sort -u)
EMPS=$(curl -s -b "$J" "$BASE/applications/new" | grep -o 'emp_[a-f0-9]*' | sort -u)
pick(){ echo "$1" | sed -n "$(( ($2 % $(echo "$1" | wc -l | tr -d ' ')) + 1 ))p"; }

N=0
mk(){ # category insurer appno customer premium logindate product
  N=$((N+1))
  post "$BASE/applications" -d "category=$1&insurer_id=$2&application_no=$3&customer_name=$4&premium=$5&login_date=$6&product_name=$7&partner_id=$(pick "$PARTNERS" $N)&employee_id=$(pick "$EMPS" $N)&premium_frequency=Annual&policy_term=1 year" >/dev/null
  curl -s -b "$J" "$BASE/applications?q=$3" | grep -o 'app_[a-f0-9]*' | head -1
}
upload(){ curl -s -b "$J" -H "Origin: $BASE" -o /dev/null -X POST "$BASE/applications/$1/documents" -F "doc_type=$2" -F "file=@$3"; }
move(){ post "$BASE/applications/$1/transition" -d "to=$2&remark=${3:-}" >/dev/null; }

doc "Proposal Form"   "Coveresy Insurtech Private Limited" "Signed by the proposer" proposal
doc "Payment Receipt" "Coveresy Insurtech Private Limited" "Premium received in full" receipt
doc "Policy Copy"     "Coveresy Insurtech Private Limited" "Policy schedule and wordings" policy

full(){ # app -> all three docs, verified, issued
  upload "$1" proposal_form "$TMP/proposal.pdf"; upload "$1" payment_receipt "$TMP/receipt.pdf"
  upload "$1" policy_copy "$TMP/policy.pdf"
  for d in $(curl -s -b "$J" "$BASE/applications/$1" | grep -o 'doc_[a-f0-9]*' | sort -u); do
    post "$BASE/documents/$d/verify" >/dev/null
  done
  move "$1" application_logged; move "$1" documents_uploaded; move "$1" pending_verification
  move "$1" verified; move "$1" submitted_to_insurer
}

A=$(mk health "$STAR"  CVR-H-20261001 "Rohan Mehta"        24500  2026-09-14 "Family Health Optima")
full "$A"; post "$BASE/applications/$A" -d "category=health&insurer_id=$STAR&application_no=CVR-H-20261001&customer_name=Rohan Mehta&premium=24500&login_date=2026-09-14&policy_no=STR/2026/884102&issued_date=2026-09-22&product_name=Family Health Optima" >/dev/null
move "$A" policy_issued
say "CVR-H-20261001  Rohan Mehta — issued, documents verified"

B=$(mk life "$HDFCL" CVR-L-20261002 "Sneha Iyer"          48000  2026-09-18 "Click 2 Protect Super")
upload "$B" proposal_form "$TMP/proposal.pdf"; upload "$B" payment_receipt "$TMP/receipt.pdf"
for d in $(curl -s -b "$J" "$BASE/applications/$B" | grep -o 'doc_[a-f0-9]*' | sort -u); do post "$BASE/documents/$d/verify" >/dev/null; done
move "$B" application_logged; move "$B" documents_uploaded; move "$B" pending_verification; move "$B" verified
say "CVR-L-20261002  Sneha Iyer — LIFE, verified with NO policy copy (the rule in action)"

C=$(mk health "$HDFCE" CVR-H-20261003 "Imran Qureshi"      31200  2026-09-21 "Optima Secure")
upload "$C" proposal_form "$TMP/proposal.pdf"; upload "$C" payment_receipt "$TMP/receipt.pdf"
move "$C" application_logged
say "CVR-H-20261003  Imran Qureshi — HEALTH blocked, policy copy missing"

D=$(mk health "$NIVA" CVR-H-20261004 "Kavita Deshpande"   18750  2026-09-25 "ReAssure 2.0")
upload "$D" proposal_form "$TMP/proposal.pdf"; upload "$D" payment_receipt "$TMP/receipt.pdf"
upload "$D" policy_copy "$TMP/policy.pdf"
RD=$(curl -s -b "$J" "$BASE/applications/$D" | grep -o 'doc_[a-f0-9]*' | head -1)
post "$BASE/documents/$RD/reject" -d "notes=Scan is illegible on page 2 — please re-upload" >/dev/null
move "$D" application_logged
say "CVR-H-20261004  Kavita Deshpande — document rejected with a reason"

E=$(mk life "$MAXL" CVR-L-20261005 "Aditya Banerjee"      62000  2026-09-28 "Smart Secure Plus")
full "$E"; post "$BASE/applications/$E" -d "category=life&insurer_id=$MAXL&application_no=CVR-L-20261005&customer_name=Aditya Banerjee&premium=62000&login_date=2026-09-28&policy_no=MAX/2026/55310&issued_date=2026-10-05&product_name=Smart Secure Plus" >/dev/null
move "$E" policy_issued
say "CVR-L-20261005  Aditya Banerjee — issued"

F=$(mk health "$ICICIL" CVR-H-20261006 "Pooja Raghavan"   27400  2026-10-01 "Health AdvantEdge")
upload "$F" proposal_form "$TMP/proposal.pdf"; upload "$F" payment_receipt "$TMP/receipt.pdf"
upload "$F" policy_copy "$TMP/policy.pdf"
move "$F" application_logged; move "$F" documents_uploaded; move "$F" pending_verification
say "CVR-H-20261006  Pooja Raghavan — waiting in the verification queue"

G=$(mk life "$IPRU" CVR-L-20261007 "Harish Pillai"        39500  2026-10-03 "iProtect Smart")
move "$G" application_logged
say "CVR-L-20261007  Harish Pillai — logged, no documents yet"

H=$(mk health "$STAR" CVR-H-20261008 "Ananya Ghosh"       52300  2026-10-06 "Star Comprehensive")
full "$H"
say "CVR-H-20261008  Ananya Ghosh — verified, submitted to insurer"

mk health "$HDFCE" CVR-H-20261009 "Mohammed Rafi"         21900  2026-10-08 "Optima Secure" >/dev/null
mk life   "$HDFCL" CVR-L-20261010 "Lakshmi Narayan"       45000  2026-10-09 "Click 2 Protect Super" >/dev/null
say "2 more in draft"

# --- payouts -----------------------------------------------------------------
PAID=0
for po in $(curl -s -b "$J" "$BASE/payouts?status=pending" | grep -o 'po_[a-f0-9]*' | sort -u | head -3); do
  post "$BASE/payouts/$po/approve" >/dev/null
  PAID=$((PAID+1))
  post "$BASE/payouts/$po/pay" -d "paid_date=2026-10-10&utr=UTR2026101000$PAID&remarks=NEFT via HDFC Bank" >/dev/null
done
say "$PAID payouts approved and paid, the rest left pending"

echo
echo "Done. Sign in at $BASE"
echo "  Admin     $ADMIN_EMAIL / $ADMIN_PASS"
echo "  Operator  priya@coveresy.com / OperatorDemo2026"
echo "  Viewer    deepak@coveresy.com / ViewerDemo2026!"
