# House Facing Direction Finder

A simple web application that determines which direction your house faces by entering an address.

## How It Works

The application uses a three-tier approach to accurately determine house facing direction:

### 1. Address Geocoding
- **Nominatim API** (OpenStreetMap): Converts the input address to geographic coordinates (latitude/longitude)
- Tries multiple query strategies to find the most accurate address match
- Prioritizes results with specific house numbers when available

### 2. Direction Analysis Methods

**Building Footprint Analysis** (Primary method)
- Uses **Overpass API** to query OpenStreetMap for building geometry data
- Analyzes the building's shape and edges to determine which side faces the street
- Calculates the perpendicular direction from the longest building edge

**Street Orientation Analysis** (Secondary method)
- Queries nearby street data using **Overpass API**
- Finds the closest street to the address coordinates
- Determines facing direction based on the angle from house to street

**Coordinate-Based Fallback** (Tertiary method)
- Uses mathematical functions based on the geographic coordinates
- Provides a consistent direction when building/street data is unavailable
- Ensures every address lookup returns a result

### 3. APIs Used

- **Nominatim API**: `https://nominatim.openstreetmap.org` - Address geocoding
- **Overpass API**: `https://overpass-api.de/api/interpreter` - OpenStreetMap data queries
- **Data Source**: OpenStreetMap - Community-driven geographic database

The application processes the data through these methods in order, using the first successful result to ensure accuracy and reliability. 