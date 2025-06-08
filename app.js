// Configuration constants
const CONFIG = {
    API: {
        NOMINATIM_BASE_URL: 'https://nominatim.openstreetmap.org',
        OVERPASS_URL: 'https://overpass-api.de/api/interpreter',
        REQUEST_TIMEOUT: 15000, // Increased timeout
        MAX_RETRIES: 3
    },
    SEARCH: {
        BUILDING_BBOX_OFFSET: 0.001,
        STREET_BBOX_OFFSET: 0.002,
        EXTENDED_STREET_BBOX_OFFSET: 0.003
    }
};

// Custom error classes for better error handling
class AddressNotFoundError extends Error {
    constructor(message = 'Address not found. Please check the address and try again.') {
        super(message);
        this.name = 'AddressNotFoundError';
    }
}

class APIError extends Error {
    constructor(message, statusCode = null) {
        super(message);
        this.name = 'APIError';
        this.statusCode = statusCode;
    }
}

class HouseFacingDirectionApp {
    constructor() {
        this.abortController = null; // For canceling ongoing requests
        this.cache = new Map(); // Cache for consistent results
        this.init();
    }

    init() {
        this.bindEvents();
    }

    bindEvents() {
        const searchBtn = document.getElementById('searchBtn');
        const addressInput = document.getElementById('addressInput');

        searchBtn.addEventListener('click', () => this.handleSearch());
        
        addressInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.handleSearch();
            }
        });
    }

    // Utility method to prevent rapid multiple clicks
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    handleSearch() {
        // Cancel any ongoing request
        if (this.abortController) {
            this.abortController.abort();
        }
        this.searchAddress();
    }

    async searchAddress() {
        const address = this.getAddressInput();
        
        if (!address) {
            this.showError('Please enter an address');
            return;
        }

        // Check cache first for consistency
        const normalizedAddress = address.toLowerCase().trim();
        if (this.cache.has(normalizedAddress)) {
            const cachedResult = this.cache.get(normalizedAddress);
            this.resetResults(); // Clear any previous error or results
            this.displayResults(cachedResult.displayName, cachedResult.facingDirection);
            return;
        }

        this.abortController = new AbortController();
        
        try {
            this.setLoadingState(true);
            this.resetResults();

            const coordinates = await this.geocodeAddress(address);
            const facingDirection = await this.calculateFacingDirection(coordinates, address);
            
            // Cache the result for consistency
            this.cache.set(normalizedAddress, {
                displayName: coordinates.display_name,
                facingDirection: facingDirection
            });
            
            this.displayResults(coordinates.display_name, facingDirection);
            
        } catch (error) {
            this.handleSearchError(error);
        } finally {
            this.setLoadingState(false);
            this.abortController = null;
        }
    }

    getAddressInput() {
        return document.getElementById('addressInput').value.trim();
    }

    setLoadingState(isLoading) {
        this.showLoading(isLoading);
        const searchBtn = document.getElementById('searchBtn');
        const addressInput = document.getElementById('addressInput');
        
        searchBtn.disabled = isLoading;
        addressInput.disabled = isLoading;
        searchBtn.textContent = isLoading ? 'Searching...' : 'Search';
    }

    resetResults() {
        this.hideResults();
        this.hideError();
    }

    handleSearchError(error) {
        if (error.name === 'AbortError') {
            return; // Request was cancelled, don't show error
        }
        
        let errorMessage = 'An unexpected error occurred. Please try again.';
        
        if (error instanceof AddressNotFoundError) {
            errorMessage = error.message;
        } else if (error instanceof APIError) {
            errorMessage = `API Error: ${error.message}`;
        } else if (error.message) {
            errorMessage = error.message;
        }
        
        this.showError(errorMessage);
    }

    async geocodeAddress(address) {
        // Try multiple geocoding strategies for better results
        const strategies = [
            // Strategy 1: Try exact address as entered
            { query: address, description: 'exact input' },
            // Strategy 2: Add USA for US-based searches
            { query: `${address}, USA`, description: 'with country' }
        ];

        let bestResult = null;
        let bestScore = -1;

        for (const strategy of strategies) {
            try {
                console.log(`Trying geocoding strategy: ${strategy.description} - "${strategy.query}"`);
                
                const encodedAddress = encodeURIComponent(strategy.query);
                const url = `${CONFIG.API.NOMINATIM_BASE_URL}/search?format=json&q=${encodedAddress}&limit=5&addressdetails=1`;
                
                const response = await this.fetchWithTimeout(url, {
                    signal: this.abortController.signal
                });
                
                if (!response.ok) {
                    console.log(`Strategy "${strategy.description}" failed with status: ${response.status}`);
                    continue;
                }
                
                const data = await response.json();
                console.log(`Strategy "${strategy.description}" returned ${data.length} results:`, data.map(r => ({
                    display_name: r.display_name,
                    type: r.type,
                    importance: r.importance,
                    house_number: r.address?.house_number,
                    road: r.address?.road
                })));
                
                if (data && data.length > 0) {
                    // Look for the best match - prefer results with house numbers
                    for (const result of data) {
                        let score = parseFloat(result.importance || 0);
                        
                        // Boost score if it has a house number
                        if (result.address?.house_number) {
                            score += 0.5;
                            console.log(`Found result with house number: ${result.address.house_number} ${result.address.road}`);
                        }
                        
                        // Boost score if it's a house/building
                        if (result.type === 'house' || result.type === 'building') {
                            score += 0.3;
                        }
                        
                        if (score > bestScore) {
                            bestScore = score;
                            bestResult = result;
                        }
                    }
                    
                    // If we found a good result with this strategy, use it
                    if (bestResult && (bestResult.address?.house_number || bestScore > 0.5)) {
                        console.log(`Using best result from strategy "${strategy.description}":`, {
                            display_name: bestResult.display_name,
                            house_number: bestResult.address?.house_number,
                            road: bestResult.address?.road,
                            score: bestScore
                        });
                        break;
                    }
                }
            } catch (error) {
                console.log(`Strategy "${strategy.description}" failed:`, error.message);
                continue;
            }
        }
        
        if (!bestResult) {
            throw new AddressNotFoundError();
        }
        
        const coordinates = {
            lat: parseFloat(bestResult.lat),
            lng: parseFloat(bestResult.lon),
            display_name: bestResult.display_name
        };
        
        // Enhanced logging for found address
        console.log('Final address selected:', {
            input: address,
            found: bestResult.display_name,
            coordinates: `${coordinates.lat}, ${coordinates.lng}`,
            type: bestResult.type,
            importance: bestResult.importance,
            score: bestScore,
            address_details: {
                house_number: bestResult.address?.house_number,
                road: bestResult.address?.road,
                city: bestResult.address?.city || bestResult.address?.town,
                state: bestResult.address?.state,
                postcode: bestResult.address?.postcode
            }
        });
        
        return coordinates;
    }

    // Utility method for fetch with timeout
    async fetchWithTimeout(url, options = {}) {
        const timeout = CONFIG.API.REQUEST_TIMEOUT;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            return response;
        } catch (error) {
            clearTimeout(timeoutId);
            throw error;
        }
    }

    async calculateFacingDirection(coordinates, address) {
        // Use a deterministic approach with proper fallbacks
        let result = null;
        let method = 'unknown';

        // Method 1: Try building-based calculation with timeout protection
        try {
            const buildingResult = await Promise.race([
                this.tryBuildingBasedCalculation(coordinates),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Building timeout')), 8000))
            ]);
            
            if (buildingResult) {
                result = buildingResult;
                method = 'building';
            }
        } catch (error) {
            // Continue to next method
        }

        // Method 2: Try street orientation analysis with timeout protection
        if (!result) {
            try {
                const streetResult = await Promise.race([
                    this.tryStreetOrientationCalculation(coordinates),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Street timeout')), 8000))
                ]);
                
                if (streetResult) {
                    result = streetResult;
                    method = 'street';
                }
            } catch (error) {
                // Continue to error handling
            }
        }

        // If no method worked, throw an error
        if (!result) {
            throw new Error('Direction could not be determined. Try another address.');
        }

        return result;
    }

    async tryBuildingBasedCalculation(coordinates) {
        try {
            const buildingData = await this.getBuildingData(coordinates);
            
            if (buildingData?.elements?.length > 0) {
                const building = buildingData.elements[0];
                if (building.nodes?.length > 0) {
                    return await this.calculateFacingFromBuilding(building, coordinates);
                }
            }
            return null;
        } catch (error) {
            return null;
        }
    }

    async tryStreetOrientationCalculation(coordinates) {
        try {
            return await this.calculateFacingFromStreetOrientation(coordinates);
        } catch (error) {
            return null;
        }
    }

    async getBuildingData(coordinates) {
        const bbox = this.getBoundingBox(coordinates, CONFIG.SEARCH.BUILDING_BBOX_OFFSET);
        const query = this.buildOverpassQuery('building', bbox);
        
        return await this.executeOverpassQuery(query);
    }

    buildOverpassQuery(type, bbox) {
        return `
            [out:json][timeout:${CONFIG.API.REQUEST_TIMEOUT / 1000}];
            (
                way["${type}"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
                relation["${type}"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
            );
            out geom;
        `;
    }

    async executeOverpassQuery(query) {
        const response = await this.fetchWithTimeout(CONFIG.API.OVERPASS_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: `data=${encodeURIComponent(query)}`,
            signal: this.abortController.signal
        });
        
        if (!response.ok) {
            throw new APIError('Failed to fetch data from Overpass API');
        }
        
        return await response.json();
    }

    async calculateFacingFromBuilding(building, targetCoordinates) {
        if (!building.nodes || building.nodes.length < 3) {
            throw new Error('Insufficient building data');
        }

        // Try to find the edge closest to a street (likely the front face)
        return await this.findFrontFacingEdge(building, targetCoordinates);
    }

    async findFrontFacingEdge(building, coordinates) {
        try {
            const streetData = await this.getNearbyStreetData(coordinates);
            
            if (streetData?.elements?.length > 0) {
                const closestEdgeToStreet = this.findClosestBuildingEdgeToStreet(building, streetData);
                
                if (closestEdgeToStreet) {
                    const facingBearing = this.calculateBearing(
                        closestEdgeToStreet.midpoint.lat, closestEdgeToStreet.midpoint.lng,
                        closestEdgeToStreet.closestStreetPoint.lat, closestEdgeToStreet.closestStreetPoint.lng
                    );
                    
                    return this.bearingToDirection(facingBearing);
                }
            }
        } catch (error) {
            // Continue to fallback method
        }

        // Fallback: Find the longest edge and assume it faces perpendicular toward the street
        return this.calculateFacingFromLongestEdge(building);
    }

    async getNearbyStreetData(coordinates) {
        const bbox = this.getBoundingBox(coordinates, CONFIG.SEARCH.EXTENDED_STREET_BBOX_OFFSET);
        const query = this.buildOverpassQuery('highway', bbox);
        
        return await this.executeOverpassQuery(query);
    }

    findClosestBuildingEdgeToStreet(building, streetData) {
        let closestEdgeToStreet = null;
        let minDistanceToStreet = Infinity;

        for (let i = 0; i < building.nodes.length - 1; i++) {
            const edgeStart = building.nodes[i];
            const edgeEnd = building.nodes[i + 1];
            const edgeMidpoint = {
                lat: (edgeStart.lat + edgeEnd.lat) / 2,
                lng: (edgeStart.lon + edgeEnd.lon) / 2
            };

            streetData.elements.forEach(street => {
                if (street.nodes?.length >= 2) {
                    for (let j = 0; j < street.nodes.length - 1; j++) {
                        const streetSegmentStart = street.nodes[j];
                        const streetSegmentEnd = street.nodes[j + 1];
                        
                        const closestPointOnStreet = this.getClosestPointOnLineSegment(
                            edgeMidpoint, streetSegmentStart, streetSegmentEnd
                        );
                        
                        const distance = this.calculateDistance(
                            edgeMidpoint.lat, edgeMidpoint.lng,
                            closestPointOnStreet.lat, closestPointOnStreet.lng
                        );
                        
                        if (distance < minDistanceToStreet) {
                            minDistanceToStreet = distance;
                            closestEdgeToStreet = {
                                start: edgeStart,
                                end: edgeEnd,
                                midpoint: edgeMidpoint,
                                closestStreetPoint: closestPointOnStreet
                            };
                        }
                    }
                }
            });
        }

        return closestEdgeToStreet;
    }

    calculateFacingFromLongestEdge(building) {
        let longestEdge = null;
        let maxLength = 0;

        for (let i = 0; i < building.nodes.length - 1; i++) {
            const node1 = building.nodes[i];
            const node2 = building.nodes[i + 1];
            
            const length = this.calculateDistance(node1.lat, node1.lon, node2.lat, node2.lon);
            
            if (length > maxLength) {
                maxLength = length;
                longestEdge = { node1, node2 };
            }
        }

        if (longestEdge) {
            const edgeBearing = this.calculateBearing(
                longestEdge.node1.lat, longestEdge.node1.lon,
                longestEdge.node2.lat, longestEdge.node2.lon
            );
            
            // The facing direction is perpendicular to the longest edge
            const perpendicular1 = (edgeBearing + 90) % 360;
            return this.bearingToDirection(perpendicular1);
        }

        throw new Error('Could not determine building orientation');
    }

    async calculateFacingFromStreetOrientation(coordinates) {
        const bbox = this.getBoundingBox(coordinates, CONFIG.SEARCH.STREET_BBOX_OFFSET);
        const query = this.buildOverpassQuery('highway', bbox);
        const data = await this.executeOverpassQuery(query);
        
        if (data.elements?.length > 0) {
            // Sort streets by distance to get most relevant ones
            const streetDistances = [];
            
            data.elements.forEach((street, index) => {
                if (street.geometry?.length >= 2) {
                    let minDistance = Infinity;
                    
                    for (let i = 0; i < street.geometry.length - 1; i++) {
                        const segmentStart = street.geometry[i];
                        const segmentEnd = street.geometry[i + 1];
                        
                        const closestOnSegment = this.getClosestPointOnLineSegment(
                            coordinates, segmentStart, segmentEnd
                        );
                        
                        const distance = this.calculateDistance(
                            coordinates.lat, coordinates.lng,
                            closestOnSegment.lat, closestOnSegment.lng
                        );
                        
                        minDistance = Math.min(minDistance, distance);
                    }
                    
                    streetDistances.push({ street, distance: minDistance, index });
                }
            });
            
            // Sort by distance and take the closest street
            streetDistances.sort((a, b) => a.distance - b.distance);
            
            if (streetDistances.length > 0) {
                const closestStreetData = streetDistances[0];
                const closestStreetPoint = this.findClosestStreetPointOnStreet(coordinates, closestStreetData.street);
                
                if (closestStreetPoint) {
                    const facingBearing = this.calculateBearing(
                        coordinates.lat, coordinates.lng,
                        closestStreetPoint.lat, closestStreetPoint.lng
                    );
                    
                    return this.bearingToDirection(facingBearing);
                }
            }
        }

        throw new Error('No suitable street data found');
    }

    findClosestStreetPointOnStreet(coordinates, street) {
        let closestPoint = null;
        let minDistance = Infinity;
        
        if (street.geometry?.length >= 2) {
            for (let i = 0; i < street.geometry.length - 1; i++) {
                const segmentStart = street.geometry[i];
                const segmentEnd = street.geometry[i + 1];
                
                const closestOnSegment = this.getClosestPointOnLineSegment(
                    coordinates, segmentStart, segmentEnd
                );
                
                const distance = this.calculateDistance(
                    coordinates.lat, coordinates.lng,
                    closestOnSegment.lat, closestOnSegment.lng
                );
                
                if (distance < minDistance) {
                    minDistance = distance;
                    closestPoint = closestOnSegment;
                }
            }
        }
        
        return closestPoint;
    }

    findClosestStreetPoint(coordinates, streetElements) {
        let closestPoint = null;
        let minDistance = Infinity;
        
        streetElements.forEach((street, streetIndex) => {
            if (street.geometry?.length >= 2) {
                for (let i = 0; i < street.geometry.length - 1; i++) {
                    const segmentStart = street.geometry[i];
                    const segmentEnd = street.geometry[i + 1];
                    
                    const closestOnSegment = this.getClosestPointOnLineSegment(
                        coordinates, segmentStart, segmentEnd
                    );
                    
                    const distance = this.calculateDistance(
                        coordinates.lat, coordinates.lng,
                        closestOnSegment.lat, closestOnSegment.lng
                    );
                    
                    if (distance < minDistance) {
                        minDistance = distance;
                        closestPoint = closestOnSegment;
                    }
                }
            }
        });
        
        return closestPoint;
    }

    // Helper method to find the closest point on a line segment to a given point
    getClosestPointOnLineSegment(point, lineStart, lineEnd) {
        // Handle coordinate property name differences: point uses .lng, line points use .lon
        const pointLng = point.lng || point.lon;
        const lineStartLng = lineStart.lng || lineStart.lon;
        const lineEndLng = lineEnd.lng || lineEnd.lon;
        
        const A = point.lat - lineStart.lat;
        const B = pointLng - lineStartLng;
        const C = lineEnd.lat - lineStart.lat;
        const D = lineEndLng - lineStartLng;

        const dot = A * C + B * D;
        const lenSq = C * C + D * D;
        
        if (lenSq === 0) {
            // Line segment is actually a point
            return { lat: lineStart.lat, lng: lineStartLng };
        }
        
        let param = dot / lenSq;
        
        // Clamp to line segment
        if (param < 0) {
            param = 0;
        } else if (param > 1) {
            param = 1;
        }
        
        return {
            lat: lineStart.lat + param * C,
            lng: lineStartLng + param * D
        };
    }

    getBoundingBox(coordinates, offset) {
        return {
            north: coordinates.lat + offset,
            south: coordinates.lat - offset,
            east: coordinates.lng + offset,
            west: coordinates.lng - offset
        };
    }

    calculateDistance(lat1, lon1, lat2, lon2) {
        const R = 6371e3; // Earth's radius in meters
        const φ1 = lat1 * Math.PI/180;
        const φ2 = lat2 * Math.PI/180;
        const Δφ = (lat2-lat1) * Math.PI/180;
        const Δλ = (lon2-lon1) * Math.PI/180;

        const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
                Math.cos(φ1) * Math.cos(φ2) *
                Math.sin(Δλ/2) * Math.sin(Δλ/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

        return R * c;
    }

    calculateBearing(lat1, lon1, lat2, lon2) {
        const φ1 = lat1 * Math.PI/180;
        const φ2 = lat2 * Math.PI/180;
        const Δλ = (lon2-lon1) * Math.PI/180;

        const y = Math.sin(Δλ) * Math.cos(φ2);
        const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

        const θ = Math.atan2(y, x);
        return (θ * 180/Math.PI + 360) % 360;
    }

    bearingToDirection(bearing) {
        const directions = [
            { name: 'North', min: 337.5, max: 360 },
            { name: 'North', min: 0, max: 22.5 },
            { name: 'Northeast', min: 22.5, max: 67.5 },
            { name: 'East', min: 67.5, max: 112.5 },
            { name: 'Southeast', min: 112.5, max: 157.5 },
            { name: 'South', min: 157.5, max: 202.5 },
            { name: 'Southwest', min: 202.5, max: 247.5 },
            { name: 'West', min: 247.5, max: 292.5 },
            { name: 'Northwest', min: 292.5, max: 337.5 }
        ];

        for (const dir of directions) {
            if (bearing >= dir.min && bearing < dir.max) {
                return { direction: dir.name, bearing: Math.round(bearing) };
            }
        }

        return { direction: 'North', bearing: Math.round(bearing) };
    }

    displayResults(address, facingResult) {
        document.getElementById('foundAddress').textContent = address;
        document.getElementById('facingDirection').textContent = facingResult.direction;
        document.getElementById('compassBearing').textContent = `${facingResult.bearing}°`;

        // Update compass needle
        const needle = document.getElementById('compassNeedle');
        needle.style.transform = `translate(-50%, -100%) rotate(${facingResult.bearing}deg)`;

        this.showResults();
    }

    showResults() {
        document.getElementById('results').classList.remove('hidden');
    }

    hideResults() {
        document.getElementById('results').classList.add('hidden');
    }

    showError(message) {
        document.getElementById('errorMessage').textContent = message;
        document.getElementById('error').classList.remove('hidden');
    }

    hideError() {
        document.getElementById('error').classList.add('hidden');
    }

    showLoading(show) {
        if (show) {
            document.getElementById('loading').classList.remove('hidden');
        } else {
            document.getElementById('loading').classList.add('hidden');
        }
    }
}

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new HouseFacingDirectionApp();
});