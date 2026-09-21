import { load } from '@std/dotenv';
import { join } from '@std/path';
import postgres from 'postgres';

const env = await load();

const sql = postgres(env.DB_URL, {
  ssl: env.DB_SSL_CA_FILE ? { ca: Deno.readTextFileSync(join(Deno.cwd(), env.DB_SSL_CA_FILE)) } : undefined,
});

console.log('Cleaning all tables...');

try {
  // Delete in correct order (child tables first, then parents)
  // Junction tables first
  await sql`DELETE FROM employee_skill`;
  console.log('Cleaned employee_skill');

  await sql`DELETE FROM employee_mentor`;
  console.log('Cleaned employee_mentor');

  // Tables with foreign keys
  await sql`DELETE FROM assignment`;
  console.log('Cleaned assignment');

  await sql`DELETE FROM id_card`;
  console.log('Cleaned id_card');

  await sql`DELETE FROM employee`;
  console.log('Cleaned employee');

  // Independent tables
  await sql`DELETE FROM project`;
  console.log('Cleaned project');

  await sql`DELETE FROM skill`;
  console.log('Cleaned skill');

  await sql`DELETE FROM department`;
  console.log('Cleaned department');

  // Soft-delete test fixtures (child/junction before parents)
  await sql`DELETE FROM soft_delete_child`;
  console.log('Cleaned soft_delete_child');

  await sql`DELETE FROM soft_delete_parent_soft_delete_tag`;
  console.log('Cleaned soft_delete_parent_soft_delete_tag');

  await sql`DELETE FROM soft_delete_tag`;
  console.log('Cleaned soft_delete_tag');

  await sql`DELETE FROM soft_delete_parent`;
  console.log('Cleaned soft_delete_parent');

  await sql`DELETE FROM soft_delete_test_entity`;
  console.log('Cleaned soft_delete_test_entity');

  // Demo tables
  await sql`DELETE FROM advanced_demo`;
  console.log('Cleaned advanced_demo');

  await sql`DELETE FROM data_type_demo`;
  console.log('Cleaned data_type_demo');

  await sql`DELETE FROM spatial_demo`;
  console.log('Cleaned spatial_demo');

  await sql`DELETE FROM exposure_test_entity`;
  console.log('Cleaned exposure_test_entity');

  await sql`DELETE FROM acceptance_test_entity`;
  console.log('Cleaned acceptance_test_entity');

  console.log('All tables cleaned successfully!');
} catch (error) {
  console.error('Error cleaning tables:', error);
  Deno.exit(1);
} finally {
  await sql.end();
}
