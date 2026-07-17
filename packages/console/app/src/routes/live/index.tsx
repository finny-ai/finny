import "./index.css"
import { Meta, Title } from "@solidjs/meta"
import { createAsync } from "@solidjs/router"
import { For, Show } from "solid-js"
import { Footer } from "~/component/footer"
import { Header } from "~/component/header"
import { LocaleLinks } from "~/component/locale-links"
import { liveDashboard, type LiveDashboardRun } from "~/lib/live-dashboard"

function formatTimestamp(value: number | undefined) {
  if (!value) return "—"
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(value)
}

function displayName(run: LiveDashboardRun) {
  return run.algorithmName || run.symbol || "Finny strategy"
}

function RunCard(props: { run: LiveDashboardRun }) {
  return (
    <article data-component="live-run">
      <div data-slot="run-heading">
        <div>
          <h2>{displayName(props.run)}</h2>
          <p>{[props.run.symbol, props.run.interval].filter(Boolean).join(" · ") || "Live strategy run"}</p>
        </div>
        <span data-slot="status" data-status={props.run.hasError ? "error" : props.run.status.toLowerCase()}>
          {props.run.hasError ? "error" : props.run.status}
        </span>
      </div>
      <dl>
        <div>
          <dt>Mode</dt>
          <dd>{props.run.mode || "—"}</dd>
        </div>
        <div>
          <dt>Brokerage</dt>
          <dd>{props.run.brokerage || "—"}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{formatTimestamp(props.run.startedAt)}</dd>
        </div>
        <div>
          <dt>Last activity</dt>
          <dd>{formatTimestamp(props.run.lastEventAt)}</dd>
        </div>
      </dl>
    </article>
  )
}

export default function LiveDashboard() {
  const result = createAsync(() => liveDashboard())
  const snapshot = () => {
    const current = result()
    return current?.state === "ready" ? current.snapshot : undefined
  }

  return (
    <main data-page="live-dashboard">
      <Title>Live trading dashboard | Finny</Title>
      <LocaleLinks path="/live" />
      <Meta
        name="description"
        content="Live status and recent activity for Finny-managed paper and live trading runs."
      />
      <div data-component="container">
        <Header />
        <div data-component="content">
          <section data-component="live-hero">
            <div>
              <span data-slot="eyebrow">Finny live operations</span>
              <h1>Live trading dashboard</h1>
              <p>Current run status from Finny&apos;s append-only execution ledger.</p>
            </div>
            <Show when={snapshot()}>
              {(data) => (
                <div data-component="active-count">
                  <strong>{data().runningCountCapped ? `${data().runningCount}+` : data().runningCount}</strong>
                  <span>active runs</span>
                </div>
              )}
            </Show>
          </section>

          <Show when={result() === undefined}>
            <section data-component="dashboard-state">
              <h2>Loading live runs…</h2>
              <p>Connecting to the execution ledger.</p>
            </section>
          </Show>

          <Show when={result()?.state === "unavailable"}>
            <section data-component="dashboard-state">
              <h2>Live status is temporarily unavailable</h2>
              <p>
                The trading ledger remains authoritative. This view will recover when the dashboard connection returns.
              </p>
            </section>
          </Show>

          <Show when={snapshot()}>
            {(data) => (
              <>
                <div data-component="dashboard-meta">
                  <span>Recent runs</span>
                  <time dateTime={new Date(data().generatedAt).toISOString()}>
                    Updated {formatTimestamp(data().generatedAt)}
                  </time>
                </div>
                <Show
                  when={data().recentRuns.length > 0}
                  fallback={
                    <section data-component="dashboard-state">
                      <h2>No runs yet</h2>
                      <p>Paper and live runs will appear here after their first ledger event.</p>
                    </section>
                  }
                >
                  <section data-component="run-grid" aria-label="Recent trading runs">
                    <For each={data().recentRuns}>{(run) => <RunCard run={run} />}</For>
                  </section>
                </Show>
              </>
            )}
          </Show>
        </div>
        <Footer />
      </div>
    </main>
  )
}
