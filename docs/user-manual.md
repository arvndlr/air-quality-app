# User Manual

## Air Quality Monitoring System

This manual explains how to access, operate, and manage the Air Quality Monitoring System developed for community-based air quality observation. The system consists of three main parts: the ESP32 sensor nodes, the backend API and database, and the web-based monitoring interface. The intended users of this manual are administrators, project evaluators, and operators who need to monitor real-time readings, review historical transmissions, and generate monitoring reports.

## 1. System Overview

The Air Quality Monitoring System is designed to collect air quality and environmental data from distributed ESP32-based sensor nodes and present the information through a centralized web application. Each sensor node gathers measurements such as particulate matter, gases, temperature, humidity, and supporting device health data. These readings are transmitted to the backend server, stored in a PostgreSQL database, processed into meaningful indicators such as AQI, and displayed to the user through the web dashboard.

The web application provides a set of administrative pages that allow the user to view the latest readings, compare sensor nodes, inspect historical transmissions, read pollutant information, and prepare printable reports. The application is intended for monitoring and decision support rather than direct control of the sensor hardware.

## 2. System Requirements

To use the system properly, the following requirements should be available:

- A desktop or laptop computer
- A modern web browser such as Google Chrome, Microsoft Edge, or Mozilla Firefox
- Access to the local network or deployed server where the application is hosted
- Running backend API, database, and frontend services
- Registered ESP32 sensor nodes with valid device IDs and API keys

For local development or demonstration, the system may be started using Docker Compose as described in the project README.

## 3. Accessing the System

To open the system, launch the web browser and enter the frontend address. In local development, the landing page is typically available at `http://localhost:5173`. The landing page serves as the public entry point of the application. From this page, the administrator can proceed to the login page by clicking the `Admin Login` button.

The login page is used to enter the administrative account. The current implementation uses browser-based session storage for authentication. The user must enter an email address and a password with at least eight characters. After a successful login, the system redirects the user to the administrative console. If the user is not authenticated and tries to open a protected admin page directly, the system automatically returns the user to the login page.

## 4. Logging In and Logging Out

To log in, open the `Admin Login` page and enter the administrator email and password. If either field is incomplete or invalid, the page displays a client-side error message. Once valid credentials are entered, the system stores the session in the browser and opens the admin interface.

To log out, use the `Sign out` button located in the sidebar of the admin interface. Logging out removes the stored session and returns the user to the login page. Since the current authentication method is browser-session based, closing the browser tab may also end the session.

## 5. Using the Dashboard

The `AQI Dashboard` is the primary monitoring page of the system. It displays the latest reading for the currently selected device and provides a live view of air quality conditions. At the top of the dashboard, the user can select a registered device from the device dropdown. The user may also choose the time range for the trend chart, such as day, week, month, or year, and select which metric to plot.

The dashboard presents several types of information. It shows the latest AQI result, pollutant values, trend charts, connection state, and device condition indicators. The page also displays whether the device is online or offline, whether the live WebSocket feed is connected, the time of the latest sample, battery condition when available, uptime, reset reason, and sensor state such as SO2 warmup or calibration progress. Because the dashboard receives live updates through WebSocket, newly received measurements appear without manually refreshing the page.

To use the dashboard effectively, first choose the desired sensor node from the dropdown. Then review the AQI card, pollutant cards, and trend graph. If historical chart data is not visible, verify that the selected date range contains recorded measurements. If the device is offline, the page still shows the most recent stored measurement, but no new live values will appear until the device resumes transmission.

## 6. Viewing Sensor Nodes

The `Sensor Nodes` page provides a summarized view of all registered devices in the system. Each node is displayed as a separate card containing the device name, device ID, online or offline status, latest AQI, selected pollutants, battery information, temperature, humidity, uptime, reset reason, and the time of the latest sample.

This page is useful when the administrator wants to compare the condition of multiple nodes at the same time. It allows the user to quickly determine which units are active, which nodes may have stopped transmitting, and which locations are showing higher AQI or pollutant levels. If no devices have been registered yet, the page displays a message indicating that no sensor nodes are available.

## 7. Reading Pollutant Information

The `Pollutant Info` page serves as the reference section of the system. It explains what AQI is, how AQI categories are interpreted, how sub-index values are calculated, and what pollutants are measured by the system. The page also includes descriptions of the environmental and gas sensors integrated into the project, such as PM2.5, PM10, CO, NO2, SO2, CO2, NH3, VOC, temperature, and humidity.

This section is especially useful for researchers, capstone evaluators, and users who need contextual understanding of what the displayed air quality values mean. It may also be used when writing supporting documentation or explaining the system to non-technical stakeholders.

## 8. Viewing Transmission History

The `Transmission History` page is used to inspect previously stored telemetry records. This page allows the administrator to filter measurements by device, date range, transmission state, and page number. It also displays summary statistics such as total transmissions, number of represented devices, latest transmission time, earliest transmission time, average reporting interval, and status counts.

To use this page, select a device if a single node must be reviewed, or leave the device filter empty to view all nodes. Next, select a time window such as the last 24 hours, 7 days, or 30 days. The user may also filter by transmission status, such as ready, warming, calibrating, or unknown. Once the filters are applied, the system shows a table containing timestamp, device, state, interval gap, pollutant values, environmental values, and runtime-related information.

This page is useful for checking whether devices are transmitting regularly, whether calibration stages have completed, and whether certain measurement periods contain missing or delayed samples.

## 9. Generating Administrative Reports

The `Admin Reports` page provides a print-oriented summary of system operation and recent environmental readings. It combines recent transmission history with the latest available snapshot of each device. The page includes overall transmission counts, number of active devices, online versus offline counts, average transmission cadence, SO2 readiness counts, latest ingestion time, and latest device-level AQI and battery data.

To use the report page, choose either a single device or all devices, then select the desired reporting range. The page automatically loads the relevant report data. If a printed copy is required, click the `Print report` button. This feature is intended for administrative review, capstone demonstration, or progress documentation.

## 10. Placeholder Pages

The sidebar also contains links for `FAQs`, `About Us`, `Terms`, and `Settings`. In the current version of the application, these pages are placeholders and display an under-development message. They do not yet provide full operational features.

## 11. Device Registration

Before sensor data can appear in the web interface, each ESP32 node must first be registered in the backend. Device registration is done from the backend environment using the provided device creation script. This process generates a device ID and API key. The API key must then be placed in the ESP32 firmware so that the node can authenticate when sending telemetry data to the backend server.

In local development, devices may be created using commands similar to the following:

```powershell
docker compose exec api npm run device:create -- --id esp32-publicmarket --name "Public Market"
docker compose exec api npm run device:create -- --id esp32-circleuptown --name "Circle Uptown"
docker compose exec api npm run device:create -- --id esp32-palikpikan --name "Palikpikan"
```

After registration, confirm that the device ID in the firmware matches the registered ID and that the generated API key is correctly assigned to the request header used by the node.

## 12. Starting the System

For local usage, the easiest way to start the system is through Docker Compose. Open a terminal in the project directory and run:

```powershell
docker compose up --build
```

After startup:

- Frontend landing page: `http://localhost:5173`
- Admin login page: `http://localhost:5173/admin/login`
- Backend API: `http://localhost:4000`

Before testing sensor transmission, verify that the API is reachable by opening:

```text
http://localhost:4000/healthz
```

The expected response is a JSON object confirming that the backend is healthy.

## 13. Basic Operating Procedure

The recommended operating sequence is as follows. First, start the database, API, and frontend services. Second, confirm that devices are already registered. Third, power the ESP32 sensor nodes and ensure that they can connect to the configured Wi-Fi network. Fourth, open the web application and log in as administrator. Fifth, use the dashboard and sensor node pages to confirm that measurements are being received. Finally, use the transmission history and report pages for review, troubleshooting, and documentation.

During normal operation, the administrator should periodically inspect the dashboard for AQI changes, check the Sensor Nodes page for offline devices, and review the Transmission History page if gaps in data transmission are suspected.

## 14. Troubleshooting Guide

If the ESP32 is not sending data, first confirm that the API URL configured in the firmware uses the correct network address. The device must not use `localhost` as the API host because `localhost` on the ESP32 refers to the device itself, not the computer running the server. The correct server IP address on the local network should be used instead.

If the dashboard does not show live updates, check whether the WebSocket connection indicator on the dashboard is marked as connected. If it is disconnected, verify that the backend is running and that the frontend can reach the `/ws` endpoint.

If no devices appear in the dropdown menus, verify that device registration was completed successfully. The list of devices shown in the web application comes from the backend device table, so unregistered devices will not appear in the interface.

If the chart is blank, confirm that the selected time range actually contains stored measurements. For example, if the latest transmission occurred several days ago and the current chart range is set to `Day`, the chart may show no data.

If a device appears offline, inspect whether the latest sample time is too old, whether the ESP32 still has network access, and whether the backend API is reachable. Also verify the correctness of the API key and device ID configured in the firmware.

If SO2 readings are unavailable, this may indicate that the sensor is still in warmup or calibration mode. The system is designed to show these transitional states until a stable baseline is available.

## 15. Safety and Usage Notes

This system is intended for monitoring and academic evaluation. It should not be treated as a certified regulatory-grade air quality instrument unless the hardware, calibration, and processing pipeline are formally validated according to accepted environmental standards. The administrator should also ensure that deployed devices are protected from moisture, unstable power supply, and wiring issues that may affect sensor accuracy or transmission reliability.

## 16. Summary

The Air Quality Monitoring System provides a complete workflow for acquiring, transmitting, storing, and presenting environmental sensor data. Through the web application, the administrator can monitor real-time air conditions, inspect all registered sensor nodes, review historical transmissions, study pollutant information, and generate administrative reports. Proper use of the system depends on correct device registration, stable network connectivity, and continuous operation of the frontend, backend, and database services.
