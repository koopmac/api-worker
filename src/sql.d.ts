// .sql files are bundled as plain text (see "rules" in wrangler.jsonc)
declare module "*.sql" {
  const sql: string;
  export default sql;
}
