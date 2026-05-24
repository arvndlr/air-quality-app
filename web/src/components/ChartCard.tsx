import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from "recharts";
import type { SeriesPoint } from "../api";
import { format } from "date-fns";

export function ChartCard(props: {
  title: string;
  subtitle?: string;
  points: SeriesPoint[];
  loading?: boolean;
}) {
  const chartColors = {
    axis: "#6b7a89",
    grid: "#d9e2ec",
    tooltipBackground: "#ffffff",
    tooltipBorder: "rgba(15, 23, 42, 0.12)",
    tooltipText: "#102233",
    average: "#14966a",
    minimum: "#ea580c",
    maximum: "#7c3aed",
  };
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
              <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
              <XAxis
                dataKey="t"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(t) => format(new Date(t), "HH:mm")}
                stroke={chartColors.axis}
                tick={{ fontSize: 11 }}
              />
              <YAxis stroke={chartColors.axis} tick={{ fontSize: 11 }} />
              <Tooltip
                labelFormatter={(t) => format(new Date(Number(t)), "PPpp")}
                contentStyle={{
                  background: chartColors.tooltipBackground,
                  border: `1px solid ${chartColors.tooltipBorder}`,
                  borderRadius: 8,
                  fontSize: 12,
                  color: chartColors.tooltipText,
                }}
                itemStyle={{ color: chartColors.tooltipText }}
                labelStyle={{ color: chartColors.tooltipText, fontWeight: 600 }}
              />
              <Legend wrapperStyle={{ color: chartColors.tooltipText, fontSize: 12 }} />
              <Line
                name="Average"
                type="monotone"
                dataKey="avg"
                stroke={chartColors.average}
                dot={false}
                strokeWidth={2}
              />
              <Line
                name="Min"
                type="monotone"
                dataKey="min"
                stroke={chartColors.minimum}
                dot={false}
                strokeWidth={1.5}
                strokeDasharray="4 2"
              />
              <Line
                name="Max"
                type="monotone"
                dataKey="max"
                stroke={chartColors.maximum}
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
