---
name: active-users
description: Count distinct users who logged task sessions in production over a given number of days (default 2). Opens a fly proxy, runs the query, then closes the proxy.
---

Count distinct users who logged task sessions in production over the last N days (default: 2).

## Steps

1. Start the Fly proxy in the background:
   ```
   fly proxy 5433:5432 -a titr-db &
   sleep 4
   ```

2. Run the query (replace `2` with the requested number of days if specified):
   ```sql
   SELECT COUNT(DISTINCT user_id) AS active_users
   FROM user_data,
     jsonb_array_elements(tasks_json::jsonb -> 'tasks') AS task,
     jsonb_array_elements(task -> 'sessions') AS session
   WHERE (session ->> 'start')::bigint
       > (EXTRACT(EPOCH FROM NOW() - INTERVAL '<N> days') * 1000)::bigint;
   ```
   Full command:
   ```
   psql "postgres://tikkit:qqOgaTye3v4UDtd@localhost:5433/tikkit?sslmode=disable" -c "<query above>"
   ```

3. Report the result clearly to the user.

4. Kill the proxy process when done.

## Notes
- The proxy may already be running from a previous call — the bind error is harmless, the query will still work.
- Timestamps in `sessions` are JavaScript milliseconds (epoch × 1000).
