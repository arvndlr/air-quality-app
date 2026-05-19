import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from "recharts";
import type { SeriesPoint } from "../api";
import { format } from "date-fns";

export function ChartCard(props: {
  title: string;
  subtitle?: string;
  points: SeriesPoint[];
  loading?: boolean;
}) {
  const data = props.points.map((p) => ({
    t: new Date(p.bucket).getTime(),
    avg: p.avg,
    min: p.min,
    max: p.max,
  }));
  const hasData = data.length > 0;

  return (
    <section className="chart-panel">
      <div className="chart-panel__header">
        <div className="chart-panel__title">{props.title}</div>
        {props.subtitle && <div className="chart-panel__subtitle">{props.subtitle}</div>}
        {props.loading && <div className="pill">loading</div>}
      </div>

      <div className="chart-panel__body">
        {hasData ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
              <XAxis
                dataKey="t"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(t) => format(new Date(t), "HH:mm")}
                stroke="rgba(255,255,255,0.4)"
                tick={{ fontSize: 11 }}
              />
              <YAxis stroke="rgba(255,255,255,0.4)" tick={{ fontSize: 11 }} />
              <Tooltip
                labelFormatter={(t) => format(new Date(Number(t)), "PPpp")}
                contentStyle={{
                  background: "#1a2332",
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line
                name="Average"
                type="monotone"
                dataKey="avg"
                stroke="#4ade80"
                dot={false}
                strokeWidth={2}
              />
              <Line
                name="Min"
                type="monotone"
                dataKey="min"
                stroke="#fb923c"
                dot={false}
                strokeWidth={1.5}
                strokeDasharray="4 2"
              />
              <Line
                name="Max"
                type="monotone"
                dataKey="max"
                stroke="#a78bfa"
                dot={false}
                strokeWidth={1.5}
                strokeDasharray="4 2"
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="chart__empty">{props.loading ? "Loading…" : "No data in this range yet."}</div>
        )}
      </div>
      <div className="chart-panel__footer">
        The green line shows the average, orange shows the minimum, and purple represents the maximum for each bucket.
      </div>
    </section>
  );
}
