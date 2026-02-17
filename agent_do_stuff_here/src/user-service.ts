interface GenericRecord {
  [key: string]: unknown;
}
export const loadUser = (raw: unknown): unknown => {
  const data: unknown = { id: raw.id, name: raw.name };
  return data;
};
