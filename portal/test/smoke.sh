#!/usr/bin/env bash
# §20 live smoke test. Run against a running `npm run dev` (or a staging URL).
#   BASE=http://127.0.0.1:8788 SETUP_TOKEN=... ./test/smoke.sh
set -u
BASE="${BASE:-http://127.0.0.1:8787}"
TOKEN="${SETUP_TOKEN:-$(grep COVERESY_SETUP_TOKEN .dev.vars | cut -d'"' -f2)}"
JAR=$(mktemp); OPJAR=$(mktemp); TMP=$(mktemp -d)
# Every record this run creates is suffixed, so the script is rerunnable
# against the same database (including staging) without colliding.
RUN=$(date +%s)$$
PASS=0; FAIL=0
ok(){ printf '  \033[32m✔\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
no(){ printf '  \033[31m✘\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
check(){ [ "$2" = "$3" ] && ok "$1" || no "$1 (got $2, wanted $3)"; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
# Every POST carries an Origin header; the server refuses cross-origin writes.
post(){ curl -s -b "$1" -c "$1" -H "Origin: $BASE" -o "$TMP/out" -w '%{http_code}' -X POST "${@:2}"; }

echo "== Authentication =="
check "unauthenticated dashboard redirects to login" "$(code "$BASE/")" 303
check "unauthenticated API POST is refused" "$(code -X POST "$BASE/applications" -H "Origin: $BASE")" 303
check "POST without an Origin header is refused (CSRF)" "$(code -X POST "$BASE/auth/login")" 403
check "setup rejects a wrong token" \
  "$(post "$JAR" "$BASE/auth/setup" -d "token=wrong&name=X&email=x@e.com&password=passwordpassword")" 303
# On a virgin database this is "Invalid setup token"; on a database that
# already has an admin the route closes before the token is even read. Both
# are refusals, and neither creates a user.
BEFORE_USERS=$(curl -s -i -b "$JAR" -H "Origin: $BASE" -X POST "$BASE/auth/setup" \
  -d "token=wrong&name=X&email=x@e.com&password=passwordpassword" | grep -i location)
grep -qE 'err=(Invalid|Setup)' <<<"$BEFORE_USERS" \
  && ok "a wrong setup token never creates an administrator" || no "wrong setup token not rejected"

post "$JAR" "$BASE/auth/setup" -d "token=$TOKEN&name=Anwar&email=admin@coveresy.com&password=AdminPassword123" >/dev/null
check "first admin can log in" \
  "$(post "$JAR" "$BASE/auth/login" -d "email=admin@coveresy.com&password=AdminPassword123")" 303
grep -q coveresy_session "$JAR" && ok "a session cookie is set" || no "no session cookie"
grep -qi 'HttpOnly' "$JAR" && ok "the session cookie is HttpOnly" || no "cookie is not HttpOnly"
check "setup refuses to run twice" \
  "$(post "$JAR" "$BASE/auth/setup" -d "token=$TOKEN&name=Z&email=z@e.com&password=passwordpassword")" 303
check "a wrong password is refused" \
  "$(post "$(mktemp)" "$BASE/auth/login" -d "email=admin@coveresy.com&password=nope")" 303
check "dashboard loads once authenticated" "$(code -b "$JAR" "$BASE/")" 200

echo "== Master data and an application =="
post "$JAR" "$BASE/masters/insurers" -d "name=Star Health $RUN&code=STAR$RUN" >/dev/null
# Read the id back off the Add Application form, where each option is one line.
INS=$(curl -s -b "$JAR" "$BASE/applications/new" | grep -o "ins_[a-f0-9]*[^>]*>Star Health $RUN<" | grep -o 'ins_[a-f0-9]*')
[ -n "$INS" ] && ok "insurer created" || no "insurer not created"
post "$JAR" "$BASE/masters/partners" -d "name=Arham Secure $RUN&code=ARH$RUN" >/dev/null

post "$JAR" "$BASE/applications" \
  -d "category=health&application_no=APP-H-$RUN&customer_name=Test Health&insurer_id=$INS&premium=50000" >/dev/null
APP=$(curl -s -b "$JAR" "$BASE/applications?q=APP-H-$RUN" | grep -o 'app_[a-f0-9]*' | head -1)
[ -n "$APP" ] && ok "health application created" || no "health application not created"
check "duplicate application number for the same insurer is refused" \
  "$(post "$JAR" "$BASE/applications" -d "category=health&application_no=APP-H-$RUN&customer_name=Dup&insurer_id=$INS&premium=100")" 303
curl -s -i -b "$JAR" -H "Origin: $BASE" -X POST "$BASE/applications" \
  -d "category=health&application_no=APP-H-$RUN&customer_name=Dup&insurer_id=$INS&premium=100" \
  | grep -qi 'err=.*already%20exists' && ok "duplicate is reported as a duplicate" || no "duplicate not reported"

echo "== Document rules (§3) =="
printf '%%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n' > "$TMP/doc.pdf"
printf 'this is not a pdf at all' > "$TMP/fake.pdf"
upload(){ post "$JAR" "$BASE/applications/$APP/documents" -F "doc_type=$1" -F "file=@$2;type=application/pdf"; }

check "a file whose contents are not a PDF/JPG/PNG is rejected" "$(upload policy_copy "$TMP/fake.pdf")" 303
curl -s -i -b "$JAR" -H "Origin: $BASE" -X POST "$BASE/applications/$APP/documents" \
  -F "doc_type=policy_copy" -F "file=@$TMP/fake.pdf;type=application/pdf" \
  | grep -qi 'err=Only%20PDF' && ok "content sniffing caught the fake PDF" || no "fake PDF was accepted"

curl -s -b "$JAR" "$BASE/applications/$APP" | grep -q 'Missing mandatory' \
  && ok "health application shows missing mandatory documents" || no "missing documents not shown"

# Direct API: try to verify with nothing uploaded.
check "API transition to Verified is blocked with no documents" \
  "$(post "$JAR" "$BASE/applications/$APP/transition" -d "to=verified")" 303
curl -s -i -b "$JAR" -H "Origin: $BASE" -X POST "$BASE/applications/$APP/transition" -d "to=verified" \
  | grep -qi 'err=' && ok "the server refused the direct API call" || no "direct API call was not refused"

upload proposal_form "$TMP/doc.pdf" >/dev/null
upload payment_receipt "$TMP/doc.pdf" >/dev/null
curl -s -b "$JAR" "$BASE/applications/$APP" | grep -q '2 of 3 required documents' \
  && ok "completion summary counts 2 of 3 for Health" || no "wrong completion summary"
post "$JAR" "$BASE/applications/$APP/transition" -d "to=application_logged" >/dev/null
curl -s -b "$JAR" "$BASE/applications/$APP" | grep -q 'Application Logged' \
  && ok "draft moves to Application Logged once the MIS fields are filled" || no "could not log the application"
check "Health cannot reach Documents Uploaded without the Policy Copy" \
  "$(post "$JAR" "$BASE/applications/$APP/transition" -d "to=documents_uploaded")" 303
curl -s -i -b "$JAR" -H "Origin: $BASE" -X POST "$BASE/applications/$APP/transition" -d "to=documents_uploaded" \
  | grep -qi 'err=Mandatory%20documents' && ok "the missing Policy Copy was named in the refusal" || no "refusal did not name the missing document"

upload policy_copy "$TMP/doc.pdf" >/dev/null
curl -s -b "$JAR" "$BASE/applications/$APP" | grep -q 'All mandatory documents uploaded' \
  && ok "Health is complete once all three are uploaded" || no "Health not complete with all three"

DOC=$(curl -s -b "$JAR" "$BASE/applications/$APP" | grep -o 'doc_[a-f0-9]*' | head -1)
check "a document can be rejected with a reason" \
  "$(post "$JAR" "$BASE/documents/$DOC/reject" -d "notes=illegible scan")" 303
check "a rejected mandatory document blocks Verified" \
  "$(post "$JAR" "$BASE/applications/$APP/transition" -d "to=verified")" 303
curl -s -b "$JAR" "$BASE/applications/$APP" | grep -q 'Rejected, must be resolved' \
  && ok "the rejected document is surfaced" || no "rejected document not surfaced"
post "$JAR" "$BASE/documents/$DOC/verify" >/dev/null

echo "== Life vs Health =="
post "$JAR" "$BASE/applications" \
  -d "category=life&application_no=APP-L-$RUN&customer_name=Test Life&insurer_id=$INS&premium=25000" >/dev/null
LIFE=$(curl -s -b "$JAR" "$BASE/applications?q=APP-L-$RUN" | grep -o 'app_[a-f0-9]*' | head -1)
post "$JAR" "$BASE/applications/$LIFE/documents" -F "doc_type=proposal_form" -F "file=@$TMP/doc.pdf" >/dev/null
post "$JAR" "$BASE/applications/$LIFE/documents" -F "doc_type=payment_receipt" -F "file=@$TMP/doc.pdf" >/dev/null
curl -s -b "$JAR" "$BASE/applications/$LIFE" | grep -q 'All mandatory documents uploaded' \
  && ok "Life proceeds without a Policy Copy" || no "Life blocked without a Policy Copy"
curl -s -b "$JAR" "$BASE/applications/$LIFE" | grep -q '2 of 2 required documents' \
  && ok "Life requires only 2 documents" || no "wrong Life requirement count"

# Switch Life -> Health; the same attachments must now fail.
post "$JAR" "$BASE/applications/$LIFE" \
  -d "category=health&application_no=APP-L-$RUN&customer_name=Test Life&insurer_id=$INS&premium=25000" >/dev/null
curl -s -b "$JAR" "$BASE/applications/$LIFE" | grep -q 'Missing mandatory' \
  && ok "switching Life to Health immediately triggers Health validation" || no "category switch did not re-validate"
curl -s -b "$JAR" "$BASE/applications/$LIFE" | grep -q 'Proposal Form' \
  && ok "existing attachments survived the category change" || no "attachments were lost on category change"

echo "== Roles and access (§12) =="
post "$JAR" "$BASE/users" -d "name=Op $RUN&email=op$RUN@coveresy.com&role=operator&password=OperatorPass123" >/dev/null
post "$OPJAR" "$BASE/auth/login" -d "email=op$RUN@coveresy.com&password=OperatorPass123" >/dev/null
check "an operator cannot open Users" "$(code -b "$OPJAR" "$BASE/users")" 403
check "an operator cannot open Settings" "$(code -b "$OPJAR" "$BASE/settings")" 403
check "an operator cannot open Audit Logs" "$(code -b "$OPJAR" "$BASE/audit-logs")" 403
check "an operator cannot approve a payout by direct POST" \
  "$(code -b "$OPJAR" -H "Origin: $BASE" -X POST "$BASE/payouts/any/approve")" 403
check "an operator cannot see another user's application (IDOR)" \
  "$(code -b "$OPJAR" "$BASE/applications/$APP")" 404
check "an operator cannot download another user's document (IDOR)" \
  "$(code -b "$OPJAR" "$BASE/documents/$DOC/download")" 404
check "an operator cannot verify while the setting is off" \
  "$(code -b "$OPJAR" -H "Origin: $BASE" -X POST "$BASE/documents/$DOC/verify")" 403
check "an admin CAN download the document" "$(code -b "$JAR" "$BASE/documents/$DOC/download")" 200
check "an anonymous request cannot download the document" "$(code "$BASE/documents/$DOC/download")" 303

echo "== Payouts (§9) =="
post "$JAR" "$BASE/masters/payout-rules" \
  -d "insurer_id=$INS&payout_pct=12.5&tds_pct=5&effective_from=2020-01-01" >/dev/null
post "$JAR" "$BASE/applications/$APP" \
  -d "category=health&application_no=APP-H-$RUN&customer_name=Test Health&insurer_id=$INS&premium=50000" >/dev/null
PO=$(curl -s -b "$JAR" "$BASE/payouts?q=APP-H-$RUN" | grep -o 'po_[a-f0-9]*' | head -1)
curl -s -b "$JAR" "$BASE/payouts/$PO" | grep -q '6,250.00' \
  && ok "gross payout is 12.5% of 50,000 = 6,250.00" || no "wrong gross payout"
curl -s -b "$JAR" "$BASE/payouts/$PO" | grep -q '312.50' \
  && ok "TDS is 5% of gross = 312.50" || no "wrong TDS"
curl -s -b "$JAR" "$BASE/payouts/$PO" | grep -q '5,937.50' \
  && ok "net payout is 5,937.50" || no "wrong net payout"
post "$JAR" "$BASE/payouts/$PO/approve" >/dev/null
post "$JAR" "$BASE/payouts/$PO/pay" -d "paid_date=2026-10-12&utr=UTR-$RUN" >/dev/null
curl -s -b "$JAR" "$BASE/payouts/$PO" | grep -q "UTR-$RUN" && ok "payment recorded" || no "payment not recorded"
check "a paid payout cannot be approved again" "$(post "$JAR" "$BASE/payouts/$PO/approve")" 303

echo "== Dashboard, export, audit =="
curl -s -b "$JAR" "$BASE/" | grep -q 'Total applications' && ok "dashboard renders" || no "dashboard failed"
curl -s -b "$JAR" "$BASE/export?kind=applications" | head -1 | grep -q 'Internal Record ID' \
  && ok "applications CSV exports with the §7 columns" || no "CSV export failed"
curl -s -b "$JAR" "$BASE/export?kind=payouts" | head -1 | grep -q 'Net Payout' \
  && ok "payouts CSV exports" || no "payout CSV failed"
curl -s -b "$JAR" -o "$TMP/book.xlsx" "$BASE/export?format=xlsx&kind=applications"
unzip -t "$TMP/book.xlsx" >/dev/null 2>&1 \
  && ok "applications XLSX is a valid workbook" || no "XLSX export is corrupt"
unzip -p "$TMP/book.xlsx" xl/worksheets/sheet1.xml 2>/dev/null | grep -q 'Internal Record ID' \
  && ok "XLSX carries the §7 columns" || no "XLSX missing columns"
check "a viewer-less anonymous export is refused" "$(code "$BASE/export")" 303
curl -s -b "$JAR" "$BASE/audit-logs" | grep -q 'document.verify' \
  && ok "document verification appears in the audit log" || no "verification missing from audit log"
curl -s -b "$JAR" "$BASE/audit-logs" | grep -q 'document.replace\|document.upload' \
  && ok "document upload/replace appears in the audit log" || no "upload missing from audit log"
curl -s -b "$JAR" "$BASE/audit-logs" | grep -q 'auth.login' \
  && ok "logins appear in the audit log" || no "login missing from audit log"
curl -s -b "$JAR" "$BASE/audit-logs" | grep -qi 'AdminPassword123\|'"$TOKEN" \
  && no "SECRET LEAKED INTO THE AUDIT LOG" || ok "no password or token in the audit log"
curl -s -b "$JAR" "$BASE/settings" | grep -q "$TOKEN" \
  && no "SETUP TOKEN LEAKED INTO A PAGE" || ok "the setup token is never rendered into a page"

echo
printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
