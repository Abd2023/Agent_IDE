export function SafePreview({ html }) {
  return <div>{String(html).replace(/<[^>]*>/g, "")}</div>;
}
