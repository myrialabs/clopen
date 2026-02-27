# Database System

## ➕ Adding New Migration

1. Create file: `migrations/006_description.ts`
```typescript
export const description = 'Create new table';

export function up(db) {
    db.exec('CREATE TABLE ...');
}

export function down(db) {
    db.exec('DROP TABLE ...');
}
```

2. Add to `migrations/index.ts`:
```typescript
import * as migration006 from './006_description';

export const migrations = [
    // ... existing migrations
    {
        id: '006',
        description: migration006.description,
        up: migration006.up,
        down: migration006.down
    }
];
```

3. **Restart app** → Migration runs automatically ✅

## ➕ Adding New Seeder

1. Create file: `seeders/new_seeder.ts`
```typescript
export const description = 'Seed default data';

export function seed(db) {
    // Insert default data
}
```

2. Add to `seeders/index.ts`:
```typescript
import * as newSeeder from './new_seeder';

export const seeders = [
    // ... existing seeders
    {
        name: 'new_seeder',
        description: newSeeder.description,
        seed: newSeeder.seed
    }
];
```

3. **Restart app** → Seeder runs automatically ✅

## 🔧 Important Info

- **Automatic**: Migrations/seeders run on app startup
- **Safe**: Only new migrations/seeders execute
- **Tracked**: System remembers what's already done
- **Order**: Migrations run by ID (001, 002, 003...)

## 🛠️ Development Commands

```typescript
// Reset database (dev only)
await resetDatabase();

// Check status
const pending = migrationRunner.getPendingMigrations();
```