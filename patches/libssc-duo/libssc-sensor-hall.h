/*
 * libssc: Library to expose Qualcomm Sensor Core sensors
 * Copyright (C) 2022-2026 Dylan Van Assche
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

#ifndef _LIBSSC_SENSOR_HALL_H_
#define _LIBSSC_SENSOR_HALL_H_

#include <glib.h>
#include <gio/gio.h>
#include "libssc-sensor.h"

#define SSC_TYPE_SENSOR_HALL (ssc_sensor_hall_get_type())

typedef struct _SSCSensorHall {
	SSCSensor parent;
} SSCSensorHall;

G_DECLARE_FINAL_TYPE (SSCSensorHall, ssc_sensor_hall, SSC, SENSOR_HALL, SSCSensor);

void		 	 ssc_sensor_hall_new (GCancellable *cancellable, GAsyncReadyCallback callback, gpointer user_data);
SSCSensorHall 	*ssc_sensor_hall_new_finish (GAsyncResult *result, GError **error);
SSCSensorHall 	*ssc_sensor_hall_new_sync (GCancellable *cancellable, GError **error);
void			 ssc_sensor_hall_open (SSCSensorHall *self, GCancellable *cancellable, GAsyncReadyCallback callback, gpointer user_data);
gboolean		 ssc_sensor_hall_open_finish (SSCSensorHall *self, GAsyncResult *result, GError **error);
gboolean		 ssc_sensor_hall_open_sync (SSCSensorHall *self, GCancellable *cancellable, GError **error);
void			 ssc_sensor_hall_close (SSCSensorHall *self, GCancellable *cancellable, GAsyncReadyCallback callback, gpointer user_data);
gboolean		 ssc_sensor_hall_close_finish (SSCSensorHall *self, GAsyncResult *result, GError **error);
gboolean		 ssc_sensor_hall_close_sync (SSCSensorHall *self, GCancellable *cancellable, GError **error);

#endif /* _LIBSSC_SENSOR_HALL_H_ */
