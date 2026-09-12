import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '../../db/test-helpers';
import { categories, publishers, games } from '../../db/schema';
import type { Database } from './db';
import {
    getAllCategories,
    getAllGames,
    getAllGameIds,
    getAllPublishers,
    getGameById,
} from './games';

async function seedGames(db: Database, count: number): Promise<void> {
    const [category] = await db
        .insert(categories)
        .values({ name: 'Strategy', description: 'cat' })
        .returning({ id: categories.id });
    const [publisher] = await db
        .insert(publishers)
        .values({ name: 'Pub One', description: 'pub' })
        .returning({ id: publishers.id });

    // Insert titles in reverse-alphabetical order to prove ordering is applied.
    for (let i = count; i >= 1; i--) {
        await db.insert(games).values({
            title: `Game ${String(i).padStart(2, '0')}`,
            description: `Description ${i}`,
            starRating: 4.2,
            categoryId: category.id,
            publisherId: publisher.id,
        });
    }
}

describe('games data-access helpers', () => {
    let db: Database;

    beforeEach(async () => {
        db = await createTestDatabase();
    });

    it('returns all games ordered by title', async () => {
        await seedGames(db, 3);
        const all = await getAllGames(db);
        expect(all.map((g) => g.title)).toEqual(['Game 01', 'Game 02', 'Game 03']);
        expect(all[0].category).toEqual({ id: expect.any(Number), name: 'Strategy' });
        expect(all[0].publisher).toEqual({ id: expect.any(Number), name: 'Pub One' });
    });

    it('returns all game ids ordered by title', async () => {
        await seedGames(db, 3);
        const ids = await getAllGameIds(db);
        const all = await getAllGames(db);
        expect(ids).toEqual(all.map((g) => g.id));
    });

    it('lists categories and publishers for filter controls', async () => {
        const [categoryOne] = await db.insert(categories).values({ name: 'Strategy', description: 'cat' }).returning({ id: categories.id });
        const [categoryTwo] = await db.insert(categories).values({ name: 'Puzzle', description: 'cat' }).returning({ id: categories.id });
        const [publisherOne] = await db.insert(publishers).values({ name: 'Pub One', description: 'pub' }).returning({ id: publishers.id });
        const [publisherTwo] = await db.insert(publishers).values({ name: 'Pub Two', description: 'pub' }).returning({ id: publishers.id });

        await db.insert(games).values({
            title: 'Alpha',
            description: 'Alpha description',
            starRating: 4.3,
            categoryId: categoryOne.id,
            publisherId: publisherOne.id,
        });
        await db.insert(games).values({
            title: 'Beta',
            description: 'Beta description',
            starRating: 4.5,
            categoryId: categoryTwo.id,
            publisherId: publisherTwo.id,
        });

        expect(await getAllCategories(db)).toEqual([
            { id: categoryTwo.id, name: 'Puzzle' },
            { id: categoryOne.id, name: 'Strategy' },
        ]);
        expect(await getAllPublishers(db)).toEqual([
            { id: publisherOne.id, name: 'Pub One' },
            { id: publisherTwo.id, name: 'Pub Two' },
        ]);
    });

    it('filters games by category and publisher together', async () => {
        const [strategyCategory] = await db
            .insert(categories)
            .values({ name: 'Strategy', description: 'cat' })
            .returning({ id: categories.id });
        const [puzzleCategory] = await db
            .insert(categories)
            .values({ name: 'Puzzle', description: 'cat' })
            .returning({ id: categories.id });
        const [onePublisher] = await db
            .insert(publishers)
            .values({ name: 'Pub One', description: 'pub' })
            .returning({ id: publishers.id });
        const [twoPublisher] = await db
            .insert(publishers)
            .values({ name: 'Pub Two', description: 'pub' })
            .returning({ id: publishers.id });

        await db.insert(games).values({
            title: 'Alpha',
            description: 'Alpha description',
            starRating: 4.1,
            categoryId: strategyCategory.id,
            publisherId: onePublisher.id,
        });
        await db.insert(games).values({
            title: 'Beta',
            description: 'Beta description',
            starRating: 4.8,
            categoryId: strategyCategory.id,
            publisherId: twoPublisher.id,
        });
        await db.insert(games).values({
            title: 'Gamma',
            description: 'Gamma description',
            starRating: 4.4,
            categoryId: puzzleCategory.id,
            publisherId: onePublisher.id,
        });

        const byCategory = await getAllGames(db, { categoryIds: [strategyCategory.id] });
        expect(byCategory.map((game) => game.title)).toEqual(['Alpha', 'Beta']);

        const byPublisher = await getAllGames(db, { publisherId: twoPublisher.id });
        expect(byPublisher.map((game) => game.title)).toEqual(['Beta']);

        const combined = await getAllGames(db, {
            categoryIds: [strategyCategory.id],
            publisherId: onePublisher.id,
        });
        expect(combined.map((game) => game.title)).toEqual(['Alpha']);
    });

    it('fetches a single game by id', async () => {
        await seedGames(db, 2);
        const ids = await getAllGameIds(db);
        const game = await getGameById(db, ids[0]);
        expect(game?.title).toBe('Game 01');
    });

    it('returns null for a non-existent game', async () => {
        await seedGames(db, 2);
        expect(await getGameById(db, 99999)).toBeNull();
    });
});
