import { test, expect } from '@playwright/test';

test.describe('Home Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should display the correct title', async ({ page }) => {
    await expect(page).toHaveTitle('Tailspin Toys - Crowdfunding your new favorite game!');
  });

  test('should display the main heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Welcome to Tailspin Toys', exact: true })).toBeVisible();
  });

  test('should display the site branding in header', async ({ page }) => {
    await expect(page.getByText('Tailspin Toys').first()).toBeVisible();
  });

  test('should display the welcome message', async ({ page }) => {
    await expect(page.getByText('Find your next game! And maybe even back one! Explore our collection!')).toBeVisible();
  });

  test('should filter games by category and publisher', async ({ page }) => {
    const categoryCheckbox = page.getByRole('checkbox', { name: 'Strategy' });
    const publisherSelect = page.getByLabel('Filter games by publisher');

    await test.step('apply category and publisher filters', async () => {
      await categoryCheckbox.check();
      await publisherSelect.selectOption({ label: 'CodeForge Studios' });
    });

    await test.step('verify only matching games remain visible', async () => {
      await expect(page.getByRole('link', { name: 'DevOps Dominion' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Pipeline Conquest' })).toBeHidden();
      await expect(page.getByRole('link', { name: 'Code Puzzle Chronicles' })).toBeHidden();
      await expect(page.getByTestId('filter-results-summary')).toHaveText(/Showing 1 matching game\./);
    });
  });

  test('should allow combining multiple category filters and clearing them', async ({ page }) => {
    const strategyCheckbox = page.getByRole('checkbox', { name: 'Strategy' });
    const actionCheckbox = page.getByRole('checkbox', { name: 'Action' });
    const clearButton = page.getByRole('button', { name: 'Clear all filters' });

    await strategyCheckbox.check();
    await actionCheckbox.check();

    await expect(page.getByRole('link', { name: 'DevOps Dominion' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Script Strike' })).toBeVisible();
    await expect(page.getByTestId('filter-results-summary')).toHaveText(/Showing \d+ matching games?\./);

    await clearButton.click();
    await expect(page.getByTestId('filter-results-summary')).toHaveText(/Showing all \d+ games\./);
  });
});
