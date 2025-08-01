import * as PIXI from 'pixi.js';
import { screenToWorld } from './camera';
import { PREVIEW_MODE, WORLD_SIZE } from './constants';
import { nostrService } from './nostr';
import { state } from './state';

// Cache for reusable graphics objects
let gridGraphics: PIXI.Graphics | null = null;
let cursorGraphics: PIXI.Graphics | null = null;
let previewPixelGraphics: PIXI.Graphics | null = null;
let ageIndicatorGraphics: PIXI.Graphics | null = null;

export async function setupRenderer() {
	const newApp = new PIXI.Application({
		width: window.innerWidth,
		height: window.innerHeight, // Full window height since UI is overlaid
		backgroundColor: 0xC0C0C0, // Gray background like pxls.space
		antialias: false,
		resolution: window.devicePixelRatio || 1,
		autoDensity: true,
	});
	state.app = newApp;

	const canvasContainer = document.getElementById('canvas-container')!;
	canvasContainer.appendChild(state.app.view as HTMLCanvasElement);

	// Create viewport (camera container)
	const newViewport = new PIXI.Container();
	state.viewport = newViewport;
	state.app.stage.addChild(state.viewport);

	// Create grid container
	const newGridContainer = new PIXI.Container();
	state.gridContainer = newGridContainer;
	state.viewport.addChild(state.gridContainer);

	// Create pixel container
	const newPixelContainer = new PIXI.Container();
	state.pixelContainer = newPixelContainer;
	state.viewport.addChild(state.pixelContainer);

	// Create cursor container (on top of everything)
	const newCursorContainer = new PIXI.Container();
	state.cursorContainer = newCursorContainer;
	state.viewport.addChild(state.cursorContainer);

	// Setup texture-based pixel rendering
	setupPixelTexture();

	// Setup interaction
	state.app.stage.eventMode = 'static';
	state.app.stage.hitArea = new PIXI.Rectangle(0, 0, state.app.screen.width, state.app.screen.height);
}

export function updateRenderer() {
	updatePixelTexture(); // Update pixel texture if needed

	if (state.pixelSprite) {
		state.pixelSprite.alpha = state.previewState.isActive ? PREVIEW_MODE.EXISTING_PIXEL_DIM : 1.0;
	}

	renderGrid();
	renderAgeIndicators();
	renderPreviewPixels();
	renderCursor();
}

function setupPixelTexture() {
	// Create a canvas for pixel texture
	const canvas = document.createElement('canvas');
	canvas.width = WORLD_SIZE;
	canvas.height = WORLD_SIZE;
	state.pixelCanvas = canvas;

	const context = canvas.getContext('2d')!;
	state.pixelContext = context;

	// Disable smoothing for pixel-perfect rendering
	state.pixelContext.imageSmoothingEnabled = false;

	// Create PIXI texture from canvas
	const texture = PIXI.Texture.from(state.pixelCanvas);
	state.pixelTexture = texture;

	// CRITICAL: Set texture to nearest neighbor scaling for crisp pixels
	state.pixelTexture.baseTexture.scaleMode = PIXI.SCALE_MODES.NEAREST;

	const sprite = new PIXI.Sprite(state.pixelTexture);
	state.pixelSprite = sprite;
	state.pixelContainer.addChild(state.pixelSprite);
}

function updatePixelTexture() {
	if (state.modifiedPixels.size === 0) return;

	// Only update modified pixels for performance
	state.modifiedPixels.forEach((pixelKey) => {
		const pixel = state.pixels.get(pixelKey);
		if (pixel) {
			// Clear the specific pixel area first (in case pixel was removed)
			state.pixelContext.clearRect(pixel.x, pixel.y, 1, 1);

			// Draw the pixel with original color
			if (pixel.color) {
				state.pixelContext.fillStyle = pixel.color;
				state.pixelContext.fillRect(pixel.x, pixel.y, 1, 1);
			}
		} else {
			// Pixel was removed, clear the area
			const coords = pixelKey.split(',').map(Number);
			if (coords.length === 2) {
				state.pixelContext.clearRect(coords[0], coords[1], 1, 1);
			}
		}
	});

	// Update the PIXI texture
	state.pixelTexture.update();

	// Clear change tracking
	state.modifiedPixels.clear();
}

function renderPreviewPixels() {
	// Only render preview pixels when in preview mode
	if (!state.previewState.isActive || state.previewState.pixels.size === 0) {
		if (previewPixelGraphics) {
			previewPixelGraphics.visible = false;
		}
		return;
	}

	// Create preview pixel graphics if it doesn't exist
	if (!previewPixelGraphics) {
		previewPixelGraphics = new PIXI.Graphics();
		state.pixelContainer.addChild(previewPixelGraphics);
	}

	// Show and clear the graphics
	previewPixelGraphics.visible = true;
	previewPixelGraphics.clear();

	// Calculate visible area for performance
	const topLeft = screenToWorld(0, 0);
	const bottomRight = screenToWorld(state.app.screen.width, state.app.screen.height);
	const margin = 10; // Add some margin for pixels just outside view

	const minX = Math.max(0, Math.floor(topLeft.x) - margin);
	const maxX = Math.min(WORLD_SIZE, Math.ceil(bottomRight.x) + margin);
	const minY = Math.max(0, Math.floor(topLeft.y) - margin);
	const maxY = Math.min(WORLD_SIZE, Math.ceil(bottomRight.y) + margin);

	// Render each preview pixel
	for (const previewPixel of state.previewState.pixels.values()) {
		const { x, y, color } = previewPixel;

		// Skip pixels outside visible area
		if (x < minX || x > maxX || y < minY || y > maxY) continue;

		// Draw the preview pixel with enhanced styling
		if (color && color.startsWith('#')) {
			previewPixelGraphics.beginFill(parseInt(color.replace('#', ''), 16), PREVIEW_MODE.PREVIEW_OPACITY);
			previewPixelGraphics.drawRect(x, y, 1, 1);
			previewPixelGraphics.endFill();
		}

		// Add simple border for preview pixels (only if cost mode is enabled)
		if (state.previewState.showCostMode) {
			const existingPixel = nostrService.canvas.getPixelEvent(x, y);
			let borderColor = 0x00FF00; // Green for new pixels

			if (existingPixel) {
				// Color based on age for existing pixels being overwritten
				const ageHours = (Date.now() - existingPixel.timestamp! * 1000) / (1000 * 60 * 60);
				if (ageHours < 1) borderColor = 0xFF4444; // Red - expensive (fresh)
				else if (ageHours < 24) borderColor = 0xFF8800; // Orange - moderate (recent)
				else if (ageHours < 168) borderColor = 0xFFAA00; // Yellow - cheap (older)
				else borderColor = 0x888888; // Gray - cheapest (ancient)
			}

			// Draw border
			previewPixelGraphics.lineStyle(2 / state.camera.scale, borderColor, 0.8);
			previewPixelGraphics.drawRect(x, y, 1, 1);
		}
	}
}

function renderAgeIndicators() {
	// Only show age indicators when zoomed in enough, in preview mode, and cost mode is enabled
	if (state.camera.scale < 8 || !state.previewState.isActive || !state.previewState.showCostMode) {
		if (ageIndicatorGraphics) {
			ageIndicatorGraphics.visible = false;
		}
		return;
	}

	// Create age indicator graphics if it doesn't exist
	if (!ageIndicatorGraphics) {
		ageIndicatorGraphics = new PIXI.Graphics();
		state.pixelContainer.addChild(ageIndicatorGraphics);
	}

	// Show and clear the graphics
	ageIndicatorGraphics.visible = true;
	ageIndicatorGraphics.clear();

	// Calculate visible area for performance
	const topLeft = screenToWorld(0, 0);
	const bottomRight = screenToWorld(state.app.screen.width, state.app.screen.height);

	const minX = Math.max(0, Math.floor(topLeft.x));
	const maxX = Math.min(WORLD_SIZE, Math.ceil(bottomRight.x));
	const minY = Math.max(0, Math.floor(topLeft.y));
	const maxY = Math.min(WORLD_SIZE, Math.ceil(bottomRight.y));

	// Add age indicators for existing pixels
	for (let x = minX; x <= maxX; x++) {
		for (let y = minY; y <= maxY; y++) {
			const existingPixel = nostrService.canvas.getPixelEvent(x, y);

			if (existingPixel) {
				const ageHours = (Date.now() - existingPixel.timestamp! * 1000) / (1000 * 60 * 60);

				// Calculate age category color locally
				let color: string;
				if (ageHours < 1) color = '#FF4444';   // Red - expensive
				else if (ageHours < 24) color = '#FF8800';  // Orange - moderate
				else if (ageHours < 168) color = '#FFAA00';   // Yellow - cheap
				else color = '#888888'; // Gray - cheapest

				// Draw subtle age indicator (small corner mark)
				const cornerSize = 0.2;
				if (color && color.startsWith('#')) {
					ageIndicatorGraphics.beginFill(parseInt(color.replace('#', ''), 16), 0.6);
					ageIndicatorGraphics.drawRect(x + 1 - cornerSize, y, cornerSize, cornerSize);
					ageIndicatorGraphics.endFill();
				}
			}
		}
	}
}

function renderGrid() {
	// Only render grid if zoomed in enough
	if (state.camera.scale < 2) {
		// Hide grid if not zoomed in
		if (gridGraphics) {
			gridGraphics.visible = false;
		}
		return;
	}

	// Create grid graphics if it doesn't exist
	if (!gridGraphics) {
		gridGraphics = new PIXI.Graphics();
		state.gridContainer.addChild(gridGraphics);
	}

	// Calculate grid opacity based on scale to prevent moire effect
	let gridOpacity = 0.3; // Default opacity
	if (state.camera.scale < 10) {
		// Fade out grid between scale 2-10 to reduce moire effect
		// At scale 2: opacity = 0
		// At scale 10: opacity = 0.3
		gridOpacity = Math.max(0, (state.camera.scale - 2) / 8 * 0.3);
	}

	// Show and clear the graphics
	gridGraphics.visible = true;
	gridGraphics.clear();
	gridGraphics.lineStyle(1 / state.camera.scale, 0x888888, gridOpacity);

	// Calculate visible area
	const topLeft = screenToWorld(0, 0);
	const bottomRight = screenToWorld(state.app.screen.width, state.app.screen.height);

	const startX = Math.max(0, Math.floor(topLeft.x));
	const endX = Math.min(WORLD_SIZE, Math.ceil(bottomRight.x));
	const startY = Math.max(0, Math.floor(topLeft.y));
	const endY = Math.min(WORLD_SIZE, Math.ceil(bottomRight.y));

	// Draw vertical lines
	for (let x = startX; x <= endX; x++) {
		gridGraphics.moveTo(x, startY);
		gridGraphics.lineTo(x, endY);
	}

	// Draw horizontal lines
	for (let y = startY; y <= endY; y++) {
		gridGraphics.moveTo(startX, y);
		gridGraphics.lineTo(endX, y);
	}
}

function renderCursor() {
	// Only show cursor when zoomed in enough
	if (state.camera.scale < 2) {
		// Hide cursor if not zoomed in
		if (cursorGraphics) {
			cursorGraphics.visible = false;
		}
		return;
	}

	let cursorPixelX: number | null = null;
	let cursorPixelY: number | null = null;

	// Show cursor at mouse position if mouse cursor is being tracked
	if (state.pointerState.mouseCursorPixel) {
		cursorPixelX = state.pointerState.mouseCursorPixel.x;
		cursorPixelY = state.pointerState.mouseCursorPixel.y;
	}

	// Only show cursor if we have valid coordinates and pixel is within world bounds
	if (cursorPixelX !== null && cursorPixelY !== null &&
		cursorPixelX >= 0 && cursorPixelX < WORLD_SIZE &&
		cursorPixelY >= 0 && cursorPixelY < WORLD_SIZE) {

		// Create cursor graphics if it doesn't exist
		if (!cursorGraphics) {
			cursorGraphics = new PIXI.Graphics();
			state.cursorContainer.addChild(cursorGraphics);
		}

		// Show and redraw the cursor
		cursorGraphics.visible = true;
		cursorGraphics.clear();
		cursorGraphics.lineStyle(2 / state.camera.scale, 0x000000, 0.8);

		// Safe color parsing for cursor
		let fillColor = 0xC0C0C0; // Default gray
		if (state.selectedColor && state.selectedColor.startsWith('#')) {
			fillColor = parseInt(state.selectedColor.replace('#', ''), 16);
		}

		cursorGraphics.beginFill(fillColor, 1);
		cursorGraphics.drawRect(cursorPixelX, cursorPixelY, 1, 1);
		cursorGraphics.endFill();
	} else {
		// Hide cursor if no valid position
		if (cursorGraphics) {
			cursorGraphics.visible = false;
		}
	}
}

export function captureDesignScreenshot(pixelCoords: Array<{ x: number, y: number }>): string {
	if (pixelCoords.length === 0) return '';

	// Calculate bounding box of the design
	const minX = Math.min(...pixelCoords.map(p => p.x));
	const maxX = Math.max(...pixelCoords.map(p => p.x));
	const minY = Math.min(...pixelCoords.map(p => p.y));
	const maxY = Math.max(...pixelCoords.map(p => p.y));

	// Add some padding around the design
	const padding = 5;
	const boundingMinX = Math.max(0, minX - padding);
	const boundingMaxX = Math.min(WORLD_SIZE - 1, maxX + padding);
	const boundingMinY = Math.max(0, minY - padding);
	const boundingMaxY = Math.min(WORLD_SIZE - 1, maxY + padding);

	const width = boundingMaxX - boundingMinX + 1;
	const height = boundingMaxY - boundingMinY + 1;

	// Create a temporary canvas for the screenshot
	const canvas = document.createElement('canvas');
	const ctx = canvas.getContext('2d')!;

	// Set canvas size with pixel scale for crisp rendering
	const pixelScale = 8; // Scale up each pixel for better visibility
	canvas.width = width * pixelScale;
	canvas.height = height * pixelScale;

	// Disable image smoothing for crisp pixels
	ctx.imageSmoothingEnabled = false;

	// Fill background with light gray
	ctx.fillStyle = '#f0f0f0';
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	// Draw pixels from the state instead of trying to read from canvas
	for (let x = boundingMinX; x <= boundingMaxX; x++) {
		for (let y = boundingMinY; y <= boundingMaxY; y++) {
			// Get pixel from state (includes both existing and newly submitted pixels)
			const pixelKey = `${x},${y}`;
			const pixel = state.pixels.get(pixelKey);

			if (pixel && pixel.color) {
				ctx.fillStyle = pixel.color;

				const screenX = (x - boundingMinX) * pixelScale;
				const screenY = (y - boundingMinY) * pixelScale;
				ctx.fillRect(screenX, screenY, pixelScale, pixelScale);
			}
		}
	}

	// Convert canvas to data URL
	return canvas.toDataURL('image/png');
}