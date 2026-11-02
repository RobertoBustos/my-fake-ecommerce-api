-- Purchase funnel per day (Mexico City time), from the business events the
-- sink copies to BigQuery (ops/analytics/events-sink.json). Run it in the
-- BigQuery console, or:
--   bq query --use_legacy_sql=false < ops/analytics/funnel.sql
--
-- Each Cloud Logging log becomes a table: the API's and the jobs' INFO lines
-- land in run_googleapis_com_stdout, partitioned by day. Payload fields are
-- columns under jsonPayload. include_e2e (below) = FALSE leaves out the e2e
-- suite's purchases (carts starting with "e2e-"); set it to TRUE to check
-- that a run of npm run test:e2e reached BigQuery.
--
-- A step counts distinct orders (or carts, before there is an order), so a
-- client that retries doesn't inflate it. Conversion is against the step
-- before; minutes_to_pay is the median from order.created to order.completed
-- of the orders completed that day. revenue_cents adds amounts as they are:
-- it assumes one settlement currency (settings/pricing).

DECLARE include_e2e BOOL DEFAULT FALSE;

WITH events AS (
  SELECT
    timestamp,
    DATE(timestamp, "America/Mexico_City") AS day,
    jsonPayload.event AS event,
    jsonPayload.cartid AS cart_id,
    jsonPayload.orderid AS order_id,
    jsonPayload.amount AS amount,
    jsonPayload.currency AS currency
  FROM `analytics_events.run_googleapis_com_stdout`
  WHERE jsonPayload.schemaversion >= 1
    AND (include_e2e OR NOT IFNULL(jsonPayload.e2e, FALSE))
),

steps AS (
  SELECT
    day,
    COUNT(DISTINCT IF(event = "cart.item_added", cart_id, NULL)) AS carts,
    COUNT(DISTINCT IF(event = "order.created", order_id, NULL)) AS orders,
    COUNT(DISTINCT IF(event = "order.ready_to_pay", order_id, NULL)) AS ready_to_pay,
    COUNT(DISTINCT IF(event = "payment.intent_created", order_id, NULL)) AS payment_started,
    COUNT(DISTINCT IF(event = "order.completed", order_id, NULL)) AS purchases,
    COUNTIF(event = "payment.failed") AS failed_payments,
    COUNTIF(event = "payment.blocked") AS blocked_payments,
    COUNTIF(event = "order.cancelled") AS cancelled,
    SUM(IF(event = "order.completed", amount, 0)) AS revenue_cents
  FROM events
  GROUP BY day
),

time_to_pay AS (
  SELECT
    DATE(completed.timestamp, "America/Mexico_City") AS day,
    APPROX_QUANTILES(TIMESTAMP_DIFF(completed.timestamp, created.timestamp, SECOND) / 60, 2)[OFFSET(1)]
      AS minutes_to_pay
  FROM events AS completed
  JOIN events AS created
    ON created.order_id = completed.order_id AND created.event = "order.created"
  WHERE completed.event = "order.completed"
  GROUP BY day
)

SELECT
  steps.day,
  carts,
  orders,
  ready_to_pay,
  payment_started,
  purchases,
  SAFE_DIVIDE(orders, carts) AS cart_to_order,
  SAFE_DIVIDE(ready_to_pay, orders) AS order_to_details,
  SAFE_DIVIDE(payment_started, ready_to_pay) AS details_to_payment,
  SAFE_DIVIDE(purchases, payment_started) AS payment_to_purchase,
  failed_payments,
  blocked_payments,
  cancelled,
  revenue_cents,
  minutes_to_pay
FROM steps
LEFT JOIN time_to_pay USING (day)
ORDER BY steps.day DESC;
