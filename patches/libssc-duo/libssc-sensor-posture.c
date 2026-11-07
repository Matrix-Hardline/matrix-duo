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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

#include "ssc-common.pb-c.h"
#include "ssc-sensor-posture.pb-c.h"
#include "libssc-client-private.h"
#include "libssc-common-private.h"
#include "libssc-sensor-posture.h"

#define SSC_SENSOR_POSTURE_NEAR	1
#define SSC_SENSOR_POSTURE_FAR	0
#define SSC_MSG_REPORT_MEASUREMENT_POSTURE	7788

enum {
	SIGNAL_MEASUREMENT,
	N_SIGNALS
};
static guint signals[N_SIGNALS];

typedef struct _SSCSensorPosturePrivate {
	guint report_id;
	gint state;
	gboolean reported_once;
} SSCSensorPosturePrivate;

G_DEFINE_TYPE_WITH_CODE (SSCSensorPosture, ssc_sensor_posture, SSC_TYPE_SENSOR,
			 G_ADD_PRIVATE (SSCSensorPosture))

typedef struct {
	SSCSensorPosture *sensor;
	gint state;
} SignalContext;

static void
signal_context_free (SignalContext *ctx)
{
	g_slice_free (SignalContext, ctx);
}

/*****************************************************************************/

static gboolean
emit_signal (gpointer user_data) {
	SignalContext *ctx = user_data;

	g_signal_emit (ctx->sensor, signals[SIGNAL_MEASUREMENT], 0, ctx->state);

	return G_SOURCE_REMOVE;
}

static void
report_received (SSCClient *self, guint32 msg_id, guint64 uid_high, guint64 uid_low, GArray *buf, gpointer user_data)
{
	SSCSensorPosture *sensor = SSC_SENSOR_POSTURE (user_data);
	SSCSensorPosturePrivate *priv = NULL;
	SignalContext *ctx = NULL;
	guint64 sensor_uid_low;
	guint64 sensor_uid_high;
	gint state = -1;

	g_object_get (SSC_SENSOR (sensor),
		      SSC_SENSOR_UID_HIGH, &sensor_uid_high,
		      SSC_SENSOR_UID_LOW, &sensor_uid_low,
		      NULL);

	if (sensor_uid_high != uid_high || sensor_uid_low != uid_low)
		return;
	if (msg_id == SSC_MSG_REPORT_MEASUREMENT_POSTURE) {
		SscPostureResponse *msg = ssc_posture_response__unpack (NULL, buf->len, (const uint8_t *) buf->data);
		if (msg == NULL) {
			g_warning ("Failed to unpack hall measurement message");
			return;
		}
		state = msg->state;
		ssc_posture_response__free_unpacked (msg, NULL);
	} else if (msg_id == SSC_MSG_REPORT_MEASUREMENT) {
		/* Surface Duo firmware reports this sensor as standard sensor event: value in data[0] */
		SscPostureStdEvent *ev = ssc_posture_std_event__unpack (NULL, buf->len, (const uint8_t *) buf->data);
		if (ev == NULL) {
			g_warning ("Failed to unpack posture standard event");
			return;
		}
		if (ev->n_data < 1) {
			ssc_posture_std_event__free_unpacked (ev, NULL);
			return;
		}
		state = (gint) ev->data[0];
		ssc_posture_std_event__free_unpacked (ev, NULL);
	} else {
		return;
	}
	{

		priv = ssc_sensor_posture_get_instance_private (sensor);
		if (priv->state != state || !priv->reported_once) {
			priv->state = state;
			priv->reported_once = TRUE;
			ctx = g_slice_new0 (SignalContext);
			ctx->sensor = sensor;
			ctx->state = state;
			g_idle_add_full (G_PRIORITY_DEFAULT_IDLE, emit_signal, ctx, (GDestroyNotify)signal_context_free);
		}
	}
}

static void
posture_close_ready (SSCSensor *sensor, GAsyncResult *result, gpointer user_data)
{
	g_autoptr (GTask) task = G_TASK (user_data);
	g_autoptr (GError) error = NULL;

	if (!SSC_SENSOR_CLASS (ssc_sensor_posture_parent_class)->close_finish (sensor, result, &error)) {
		g_task_return_error (task, g_steal_pointer (&error));
		return;
	}

	g_task_return_boolean (task, TRUE);
}

gboolean
ssc_sensor_posture_close_finish (SSCSensorPosture *self, GAsyncResult *result, GError **error)
{
	return g_task_propagate_boolean (G_TASK (result), error);
}

void
ssc_sensor_posture_close (SSCSensorPosture *self, GCancellable *cancellable, GAsyncReadyCallback callback, gpointer user_data)
{
	GTask *task = NULL;
	SSCClient *client = NULL;
	SSCSensorPosturePrivate *priv = NULL;

	g_assert (SSC_SENSOR_CLASS (ssc_sensor_posture_parent_class)->close &&
		  SSC_SENSOR_CLASS (ssc_sensor_posture_parent_class)->close_finish);

	task = g_task_new (self, cancellable, callback, user_data);
	priv = ssc_sensor_posture_get_instance_private (self);

	/* Stop listening for reports */
	g_object_get (SSC_SENSOR (self),
		      SSC_SENSOR_CLIENT, &client,
		      NULL);
	if (priv->report_id)
		g_signal_handler_disconnect (client, priv->report_id);

	/* Close sensor */
	SSC_SENSOR_CLASS (ssc_sensor_posture_parent_class)->close (SSC_SENSOR (self), cancellable, (GAsyncReadyCallback)posture_close_ready, task);
}

gboolean
ssc_sensor_posture_close_sync (SSCSensorPosture *self, GCancellable *cancellable, GError **error)
{
	gboolean success = FALSE;
	SyncContext ctx;

	ssc_common_init_sync_context (&ctx);
	ssc_sensor_posture_close (self, cancellable, ssc_common_callback_sync_context, &ctx);
	ssc_common_wait_sync_context (&ctx);
	success = ssc_sensor_posture_close_finish (self, ctx.result, error);
	ssc_common_clear_sync_context (&ctx);

	return success;
}

/*****************************************************************************/

static void
posture_open_ready (SSCSensor *sensor, GAsyncResult *result, gpointer user_data)
{
	g_autoptr (GTask) task = G_TASK (user_data);
	g_autoptr (GError) error = NULL;

	if (!SSC_SENSOR_CLASS (ssc_sensor_posture_parent_class)->open_finish (sensor, result, &error)) {
		g_task_return_error (task, g_steal_pointer (&error));
		return;
	}

	g_task_return_boolean (task, TRUE);
}

gboolean
ssc_sensor_posture_open_finish (SSCSensorPosture *self, GAsyncResult *result, GError **error)
{
	return g_task_propagate_boolean (G_TASK (result), error);
}

void
ssc_sensor_posture_open (SSCSensorPosture *self, GCancellable *cancellable, GAsyncReadyCallback callback, gpointer user_data)
{
	SSCClient *client = NULL;
	SSCSensorPosturePrivate *priv = NULL;
	GTask *task = NULL;

	g_assert (SSC_SENSOR_CLASS (ssc_sensor_posture_parent_class)->open &&
		  SSC_SENSOR_CLASS (ssc_sensor_posture_parent_class)->open_finish);

	priv = ssc_sensor_posture_get_instance_private (self);
	priv->reported_once = FALSE;

	task = g_task_new (self, cancellable, callback, user_data);

	/* Start listening for reports before opening sensor so we don't miss the first measurement */
	g_object_get (SSC_SENSOR (self),
		      SSC_SENSOR_CLIENT, &client,
		      NULL);
	priv->report_id = g_signal_connect (client,
					    "report",
					    G_CALLBACK (report_received),
					    self);

	/* Open sensor */
	SSC_SENSOR_CLASS (ssc_sensor_posture_parent_class)->open (SSC_SENSOR (self), cancellable, (GAsyncReadyCallback)posture_open_ready, task);
}

gboolean
ssc_sensor_posture_open_sync (SSCSensorPosture *self, GCancellable *cancellable, GError **error)
{
	gboolean success = FALSE;
	SyncContext ctx;

	ssc_common_init_sync_context (&ctx);
	ssc_sensor_posture_open (self, cancellable, ssc_common_callback_sync_context, &ctx);
	ssc_common_wait_sync_context (&ctx);
	success = ssc_sensor_posture_open_finish (self, ctx.result, error);
	ssc_common_clear_sync_context (&ctx);

	return success;
}

/*****************************************************************************/

static void
ssc_sensor_posture_class_init (SSCSensorPostureClass *klass)
{
	signals[SIGNAL_MEASUREMENT] = g_signal_new ("measurement",
		G_TYPE_FROM_CLASS (klass),
		G_SIGNAL_RUN_FIRST,
		0, NULL, NULL, NULL,
		G_TYPE_NONE,
		1, G_TYPE_INT);
}

static void
ssc_sensor_posture_init (SSCSensorPosture *self)
{
}

SSCSensorPosture *
ssc_sensor_posture_new_finish (GAsyncResult *result, GError **error)
{
	GObject *sensor;
	GObject *source;
	SSCSensorPosturePrivate *priv = NULL;

	source = g_async_result_get_source_object (result);
	sensor = g_async_initable_new_finish (G_ASYNC_INITABLE (source), result, error);

	if (!sensor) {
		g_object_unref (source);
		return NULL;
	}

	priv = ssc_sensor_posture_get_instance_private (SSC_SENSOR_POSTURE (sensor));

	/* Only bypass reporting once if the sensor is opened, not during initialization */
	priv->reported_once = TRUE;

	g_object_unref (source);
	return SSC_SENSOR_POSTURE (sensor);
}

void
ssc_sensor_posture_new (GCancellable *cancellable, GAsyncReadyCallback callback, gpointer user_data)
{
	g_async_initable_new_async (
			SSC_TYPE_SENSOR_POSTURE,
			G_PRIORITY_DEFAULT,
			cancellable,
			callback,
			user_data,
			SSC_SENSOR_DATA_TYPE, "posture",
			NULL);
}

SSCSensorPosture *
ssc_sensor_posture_new_sync (GCancellable *cancellable, GError **error)
{
	SSCSensorPosture *self = NULL;
	SyncContext ctx;

	ssc_common_init_sync_context (&ctx);
	ssc_sensor_posture_new (cancellable, ssc_common_callback_sync_context, &ctx);
	ssc_common_wait_sync_context (&ctx);
	self = ssc_sensor_posture_new_finish (ctx.result, error);
	ssc_common_clear_sync_context (&ctx);

	return self;
}
