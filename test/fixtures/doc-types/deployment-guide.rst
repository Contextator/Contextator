Deployment Guide
================

.. contents:: Table of contents
   :depth: 2

Overview
--------

The *quokka* service ships as a single container. See `the runbook <https://example.com/runbook>`_ for details.

Prerequisites
~~~~~~~~~~~~~

* A Linux host with ``systemd``
* Outbound access to the registry

Installation
------------

Run the installer::

    curl -fsSL https://example.com/install.sh | sh
    quokka --version

.. code-block:: yaml

   replicas: 3
   port: 8080

.. note::

   Back up the ``/var/lib/quokka`` directory before upgrading.

.. _internal-target:

Configuration
-------------

=========  ==========  =======
Option     Default     Notes
=========  ==========  =======
port       8080        TCP
workers    4           per CPU
=========  ==========  =======
