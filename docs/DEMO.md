# Demo script

A three-minute walkthrough of `npm run demo`. Start it a couple of minutes before you present, because the first thermal load downloads about 28 MB from NASA. The events on screen are live public data, so they will differ from the ones named here.

## Before you start

```sh
npm ci
npm run demo
```

Open the printed address, normally `http://127.0.0.1:4319/?hours=168`. Keep the terminal visible if you want to show the five-minute collection lines.

## 0:00 The map

Say what the audience is looking at. Each marker is a real record from the last week, published by USGS or GDACS and pulled a minute ago, with no model involved.

Point at the feed on the left. The top item is usually a GDACS Orange or Red alert, and earthquakes of magnitude 4.5 or more fill the rest. Click **Hazards** in the top bar to show the filter.

## 0:40 One event, all the way down

Click the most severe event in the feed. The panel shows the issuer's record as fields, such as alert level, maximum wind speed, dates, affected countries and the upstream data provider.

Read out the yellow notice. It says this record was published without model analysis. Then scroll to the caution text and show that the GDACS disclaimer and the centroid warning travel with the event. Say why severe is the ceiling here. GDACS alert levels are modelled estimates, so World Watch caps them at severe.

## 1:20 Satellites

Open the controls (the sliders icon, top right), tick **Satellite thermal detections** and **Copernicus mapping areas**, then click **Explore geospatial context**.

Thermal dots spread across the continents. Tell the audience how many there were in the last 24 hours (the panel shows it) and that every one of them is on the map: zoomed out, each dot counts the detections around it. Click a dot over a cluster and the map zooms to the single detections; click one to show its satellite, acquisition time and confidence. Point out that each dot is a heat measurement, which may or may not be a fire.

Under **Satellite imagery**, pick **True colour, VIIRS**. Yesterday's NASA mosaic replaces the dark basemap, with the sensor, overpass time and resolution listed under the date. Then open a typhoon or earthquake and press **Find recent Sentinel scenes** to list the Sentinel-2 and Sentinel-1 passes over it, each opening in the Copernicus Browser.

## 1:50 News signals

Click **News signals** in the top bar. The feed and map switch to places where GDELT's machine-geocoded news coverage of protests, conflict, displacement, curfews or disasters is concentrated in the last six hours, each drawn as a broadcast mark rather than an impact shape. Open one and show the article links, the distinct headline count and the caution at the top: this is coverage, not a verified event. For the first 12 hours of a fresh demo there is no baseline yet, so nothing is marked as rising.

## 2:00 What a model is allowed to do

The analysis worker isn't running, so the brief panel at the top shows a structured brief instead. Read the label under the headline. It was built from issuer fields, with no model. Each statement counts records you can open from the pins and the evidence list.

The model side has no live screen in the demo.

Then explain the rule. When the worker reads news, a model can only call something severe if it quotes an affirmed consequence from the cited text, such as homes destroyed or people evacuated. "No injuries", "could cause" and "evacuation drill" are rejected in the same clause, in 23 languages. If a correction arrives later, each watch rule that received the first alert gets the correction, even if the event moved out of its area.

## 2:40 Close

Close on status. The worldwide hazard map works today. Narrative coverage, calibration and the 50-sources-per-country atlas are the next work, and the [backlog](../TODO.md) lists them with acceptance tests.

Press Ctrl-C in the terminal. The demo deletes its data and stops its processes.

## If something goes wrong

- If no events appear, check the terminal. Each source prints `ok` with a record count, or the error it hit.
- If the basemap stays blank, the network is blocking OpenFreeMap. Markers and thermal dots still render on the fallback country outlines.
- If port 8797 or 4319 is taken, stop the other process first. The demo uses fixed ports so the address stays the same.
